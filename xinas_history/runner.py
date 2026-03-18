"""Transactional runner for xiNAS configuration changes.

Wraps all configuration-changing operations with:
1. Pre-operation state lock acquisition
2. Pre-change recovery snapshot creation
3. Preflight validation
4. Operation execution (Ansible playbook or direct system commands)
5. Strict post-apply validation
6. Auto-rollback on validation failure
7. Durable state recording via journal
"""
from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from .engine import SnapshotEngine
from .lock import GlobalConfigLock, LockError
from .models import (
    Manifest,
    OperationType,
    OperationSource,
    RollbackClass,
    SnapshotStatus,
    SnapshotType,
    ValidationResult,
)
from .store import FilesystemStore
from .validator import PreflightValidator, PostApplyValidator
from .gc import GarbageCollector
from .classifier import RollbackClassifier
from .grpc_inspector import GrpcInspector


logger = logging.getLogger(__name__)


@dataclass
class RunResult:
    """Result of a transactional configuration operation."""

    success: bool = False
    operation: str = ""
    snapshot_id: Optional[str] = None
    pre_change_snapshot_id: Optional[str] = None
    rollback_performed: bool = False
    rollback_success: Optional[bool] = None
    rollback_class: str = ""
    error: Optional[str] = None
    output: Optional[str] = None
    validation: Optional[dict] = None
    steps: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Serialize to a plain dict for logging / API responses."""
        result: dict = {
            "success": self.success,
            "operation": self.operation,
        }
        if self.snapshot_id is not None:
            result["snapshot_id"] = self.snapshot_id
        if self.pre_change_snapshot_id is not None:
            result["pre_change_snapshot_id"] = self.pre_change_snapshot_id
        if self.rollback_performed:
            result["rollback_performed"] = True
            result["rollback_success"] = self.rollback_success
        if self.rollback_class:
            result["rollback_class"] = self.rollback_class
        if self.error is not None:
            result["error"] = self.error
        if self.output is not None:
            result["output"] = self.output
        if self.validation is not None:
            result["validation"] = self.validation
        if self.steps:
            result["steps"] = list(self.steps)
        return result


class TransactionalRunner:
    """Wraps configuration changes with transactional guarantees.

    Ensures every major configuration change follows the required
    execution sequence with automatic rollback on failure.

    Usage::

        runner = TransactionalRunner(engine=engine)

        result = await runner.execute(
            operation="raid_create",
            source="xinas_menu",
            apply_fn=my_ansible_function,
            preset="default",
        )

        if result.success:
            print(f"Applied: {result.snapshot_id}")
        else:
            print(f"Failed: {result.error}")
            if result.rollback_performed:
                print(f"Rolled back to: {result.pre_change_snapshot_id}")
    """

    def __init__(
        self,
        engine: SnapshotEngine,
        store: Optional[FilesystemStore] = None,
        grpc_inspector: Optional[GrpcInspector] = None,
    ) -> None:
        self._engine = engine
        self._store = store or engine._store
        self._inspector = grpc_inspector or engine._inspector
        self._lock = GlobalConfigLock(str(self._store.state_path))
        self._preflight = PreflightValidator(self._store, self._inspector)
        self._post_apply = PostApplyValidator(self._inspector)
        self._gc = GarbageCollector(self._store)
        self._classifier = RollbackClassifier()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def execute(
        self,
        operation: str,
        source: str,
        apply_fn: Callable[[], Awaitable[bool]],
        preset: str = "",
        extra_vars: Optional[dict] = None,
        target_resources: Optional[list[str]] = None,
        diff_summary: Optional[str] = None,
        skip_preflight: bool = False,
    ) -> RunResult:
        """Execute a configuration change with full transactional guarantees.

        Args:
            operation: OperationType value (e.g., ``"raid_create"``).
            source: OperationSource value (e.g., ``"xinas_menu"``).
            apply_fn: Async callable that performs the actual change.
                Must return ``True`` on success, ``False`` on failure.
                Can also raise exceptions.
            preset: Active preset name.
            extra_vars: Extra variables for the operation.
            target_resources: Resource names affected (for preflight).
            diff_summary: Human-readable summary of the change.
            skip_preflight: Skip preflight validation (for emergency ops).

        Returns:
            RunResult with operation outcome.
        """
        result = RunResult(operation=operation)

        # Step 1: Classify the operation.
        try:
            op_enum = OperationType(operation)
            rollback_class = self._classifier.classify_operation(op_enum)
            result.rollback_class = rollback_class.value
        except ValueError:
            result.rollback_class = RollbackClass.NON_DISRUPTIVE.value

        # Step 2: Acquire the global configuration lock.
        try:
            self._lock.acquire(operation=operation, source=source)
            result.steps.append("lock_acquired")
        except LockError as exc:
            result.error = "Failed to acquire lock: {}".format(exc)
            logger.error("Lock acquisition failed for %s: %s", operation, exc)
            return result
        except Exception as exc:
            result.error = "Unexpected error acquiring lock: {}".format(exc)
            logger.exception("Lock acquisition error for %s", operation)
            return result

        try:
            # Step 3: Preflight validation.
            if not skip_preflight:
                try:
                    preflight_result = await self._preflight.validate(
                        operation=operation,
                        target_resources=target_resources,
                        rollback_class=result.rollback_class,
                    )
                    if not preflight_result.passed:
                        result.error = "Preflight validation failed: {}".format(
                            "; ".join(preflight_result.blockers)
                        )
                        result.validation = preflight_result.to_dict()
                        logger.warning(
                            "Preflight blocked %s: %s",
                            operation, preflight_result.blockers,
                        )
                        return result
                    result.steps.append("preflight_passed")
                except Exception as exc:
                    result.error = "Preflight validation error: {}".format(exc)
                    logger.exception("Preflight error for %s", operation)
                    return result

            # Step 4: Create pre-change recovery snapshot (ephemeral).
            try:
                pre_manifest = await self._engine.create_snapshot(
                    source=source,
                    operation=operation,
                    preset=preset,
                    snapshot_type=SnapshotType.EPHEMERAL.value,
                    extra_vars=extra_vars,
                    diff_summary="Pre-change snapshot for {}".format(operation),
                )
                result.pre_change_snapshot_id = pre_manifest.id
                self._lock.update_journal(
                    phase="snapshot_created",
                    pre_change_snapshot=pre_manifest.id,
                    step_completed="pre_snapshot_created",
                )
                result.steps.append("pre_snapshot_created")
            except Exception as exc:
                result.error = "Failed to create pre-change snapshot: {}".format(exc)
                logger.exception("Pre-change snapshot failed for %s", operation)
                return result

            # Step 5: Execute the apply function.
            self._lock.update_journal(phase="executing")
            apply_ok = False
            try:
                apply_ok = await apply_fn()
                if apply_ok:
                    result.steps.append("apply_completed")
                else:
                    result.steps.append("apply_failed")
            except Exception as exc:
                result.steps.append("apply_failed")
                apply_ok = False
                logger.exception("Apply function raised for %s", operation)
                result.error = "Apply failed with exception: {}".format(exc)

            # Step 6: Post-apply validation (only if apply succeeded).
            if apply_ok:
                self._lock.update_journal(phase="validating")
                try:
                    # Build a minimal target manifest for post-apply validation.
                    # The post-apply validator uses the manifest to determine
                    # expected state; we create a temporary one from current
                    # engine state.
                    current_effective = self._engine.get_current_effective()
                    target_manifest = current_effective or Manifest(
                        id="", timestamp="", user="", source=source,
                    )
                    post_result = await self._post_apply.validate(
                        target_manifest=target_manifest,
                    )
                    result.validation = post_result.to_dict()
                except Exception as exc:
                    # Validation itself errored — treat as failure.
                    post_result = ValidationResult(
                        passed=False,
                        blockers=["Post-apply validation error: {}".format(exc)],
                    )
                    result.validation = post_result.to_dict()
                    logger.exception(
                        "Post-apply validation error for %s", operation,
                    )

                if post_result.passed:
                    # Step 7a: Success path — create applied snapshot.
                    try:
                        applied_manifest = await self._engine.create_snapshot(
                            source=source,
                            operation=operation,
                            preset=preset,
                            snapshot_type=SnapshotType.ROLLBACK_ELIGIBLE.value,
                            extra_vars=extra_vars,
                            diff_summary=diff_summary,
                        )
                        # Mark as applied (engine already sets status=applied).
                        result.snapshot_id = applied_manifest.id
                        result.success = True
                        self._lock.update_journal(
                            phase="completed",
                            target_snapshot=applied_manifest.id,
                            step_completed="snapshot_applied",
                        )
                        result.steps.append("snapshot_applied")

                        # Run garbage collection (non-fatal).
                        try:
                            self._gc.run(
                                current_effective_id=applied_manifest.id,
                                in_progress_ids=set(),
                            )
                            result.steps.append("gc_completed")
                        except Exception:
                            logger.warning(
                                "GC failed after %s (non-fatal)", operation,
                            )
                    except Exception as exc:
                        result.error = (
                            "Failed to create applied snapshot: {}".format(exc)
                        )
                        logger.exception(
                            "Applied snapshot creation failed for %s", operation,
                        )
                        # Still a success in terms of system state change,
                        # but we failed to record it — mark as error.
                        result.success = False
                else:
                    # Step 7b: Validation failed — auto-rollback.
                    val_errors = "; ".join(post_result.blockers)
                    if result.error is None:
                        result.error = (
                            "Post-apply validation failed: {}".format(val_errors)
                        )
                    self._lock.update_journal(
                        phase="failed",
                        error="Post-apply validation failed: {}".format(val_errors),
                    )
                    logger.warning(
                        "Post-apply validation failed for %s: %s",
                        operation, val_errors,
                    )

                    # Attempt auto-rollback.
                    if result.pre_change_snapshot_id:
                        rb_ok, rb_err = await self._auto_rollback(
                            pre_change_id=result.pre_change_snapshot_id,
                            failed_operation=operation,
                        )
                        result.rollback_performed = True
                        result.rollback_success = rb_ok
                        if not rb_ok:
                            if result.error:
                                result.error += "; Rollback also failed: {}".format(
                                    rb_err or "unknown"
                                )
                            else:
                                result.error = "Rollback failed: {}".format(
                                    rb_err or "unknown"
                                )
                        result.steps.append(
                            "rollback_succeeded" if rb_ok else "rollback_failed"
                        )
            else:
                # Apply itself failed — mark and attempt rollback.
                self._lock.update_journal(
                    phase="failed",
                    error=result.error or "Apply function returned False",
                )
                if result.error is None:
                    result.error = "Apply function returned False"

                if result.pre_change_snapshot_id:
                    rb_ok, rb_err = await self._auto_rollback(
                        pre_change_id=result.pre_change_snapshot_id,
                        failed_operation=operation,
                    )
                    result.rollback_performed = True
                    result.rollback_success = rb_ok
                    if not rb_ok:
                        result.error += "; Rollback also failed: {}".format(
                            rb_err or "unknown"
                        )
                    result.steps.append(
                        "rollback_succeeded" if rb_ok else "rollback_failed"
                    )

        finally:
            # Step 8: Always release the lock.
            try:
                self._lock.release()
                result.steps.append("lock_released")
            except Exception as exc:
                logger.error("Failed to release lock: %s", exc)
                # Do not overwrite a pre-existing error.
                if result.error is None:
                    result.error = "Failed to release lock: {}".format(exc)

        return result

    async def execute_ansible(
        self,
        operation: str,
        source: str,
        playbook: str = "playbooks/site.yml",
        extra_vars: Optional[dict] = None,
        tags: Optional[list[str]] = None,
        preset: str = "",
        target_resources: Optional[list[str]] = None,
        diff_summary: Optional[str] = None,
    ) -> RunResult:
        """Convenience: execute an Ansible playbook as a transactional operation.

        Builds the ``apply_fn`` from playbook/tags/extra_vars and delegates
        to :meth:`execute`.
        """

        result_holder: dict = {}

        async def _apply() -> bool:
            ok, output = await self._run_ansible_playbook(
                playbook=playbook,
                extra_vars=extra_vars,
                tags=tags,
            )
            result_holder["output"] = output
            return ok

        run_result = await self.execute(
            operation=operation,
            source=source,
            apply_fn=_apply,
            preset=preset,
            extra_vars=extra_vars,
            target_resources=target_resources,
            diff_summary=diff_summary,
        )
        if result_holder.get("output"):
            run_result.output = result_holder["output"]
        return run_result

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _run_ansible_playbook(
        self,
        playbook: str,
        extra_vars: Optional[dict] = None,
        tags: Optional[list[str]] = None,
    ) -> tuple[bool, Optional[str]]:
        """Run an Ansible playbook as a subprocess.

        Returns ``(True, None)`` on success, or ``(False, output_tail)``
        on failure where *output_tail* contains the last 2000 characters
        of combined stdout/stderr for diagnostics.
        """
        cmd = ["ansible-playbook", playbook]

        if tags:
            cmd.extend(["--tags", ",".join(tags)])

        # Write extra_vars to a temp JSON file for -e @file syntax.
        vars_file = None
        try:
            if extra_vars:
                import os as _os
                fd, vars_path = tempfile.mkstemp(
                    suffix=".json", prefix="xinas-vars-",
                )
                try:
                    _os.write(fd, json.dumps(extra_vars).encode())
                finally:
                    _os.close(fd)
                cmd.extend(["-e", "@{}".format(vars_path)])
                vars_file = vars_path

            logger.info("Running Ansible: %s", " ".join(cmd))

            loop = asyncio.get_running_loop()
            proc_result = await loop.run_in_executor(
                None,
                lambda: subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    cwd="/opt/xiNAS",
                    timeout=3600,  # 1 hour max
                ),
            )

            if proc_result.returncode != 0:
                stdout_tail = (proc_result.stdout or "")[-2000:]
                stderr_tail = (proc_result.stderr or "")[-2000:]
                combined = ""
                if stdout_tail:
                    combined += stdout_tail
                if stderr_tail:
                    combined += "\n--- stderr ---\n" + stderr_tail
                logger.error(
                    "Ansible playbook failed (exit %d):\nstdout: %s\nstderr: %s",
                    proc_result.returncode,
                    stdout_tail,
                    stderr_tail,
                )
                return False, combined.strip() or "exit code {}".format(proc_result.returncode)

            logger.info("Ansible playbook completed successfully")
            return True, None

        except subprocess.TimeoutExpired:
            logger.error("Ansible playbook timed out after 3600s")
            return False, "Ansible playbook timed out after 3600s"
        except FileNotFoundError:
            logger.error("ansible-playbook not found in PATH")
            return False, "ansible-playbook not found in PATH"
        except Exception as exc:
            logger.exception("Ansible playbook execution error: %s", exc)
            return False, str(exc)
        finally:
            # Clean up vars temp file.
            if vars_file is not None:
                try:
                    import os as _os
                    _os.unlink(vars_file)
                except OSError:
                    pass

    async def _auto_rollback(
        self,
        pre_change_id: str,
        failed_operation: str,
    ) -> tuple[bool, Optional[str]]:
        """Attempt automatic rollback to pre-change snapshot.

        Returns ``(success, error_message)``.

        This method does NOT re-enter the transactional runner to avoid
        infinite recursion.  It directly re-runs Ansible with the
        pre-change configuration if possible.
        """
        logger.warning(
            "Initiating auto-rollback for failed operation %s "
            "to pre-change snapshot %s",
            failed_operation, pre_change_id,
        )

        self._lock.update_journal(phase="rolling_back")

        try:
            # Read the pre-change snapshot manifest to get its config.
            pre_manifest = self._store.read_manifest(pre_change_id)
            if pre_manifest is None:
                msg = "Pre-change snapshot {} not found".format(pre_change_id)
                logger.error("Auto-rollback failed: %s", msg)
                return False, msg

            # Re-run the playbook with the pre-change extra_vars.
            playbook = pre_manifest.playbook or "playbooks/site.yml"
            ok, output = await self._run_ansible_playbook(
                playbook=playbook,
                extra_vars=pre_manifest.extra_vars or None,
            )

            if ok:
                logger.info(
                    "Auto-rollback succeeded for %s", failed_operation,
                )
                # Update the pre-change snapshot status to indicate it was
                # used for rollback.
                try:
                    pre_manifest.status = SnapshotStatus.ROLLED_BACK.value
                    self._store.update_manifest(pre_change_id, pre_manifest)
                except Exception:
                    pass  # Non-fatal — the rollback itself worked.
                return True, None
            else:
                msg = "Ansible playbook failed during rollback"
                if output:
                    msg += "\n" + output
                logger.error("Auto-rollback failed: %s", msg)
                return False, msg

        except Exception as exc:
            msg = "Auto-rollback exception: {}".format(exc)
            logger.exception(msg)
            return False, msg

    # ------------------------------------------------------------------
    # Startup recovery
    # ------------------------------------------------------------------

    def recover_on_startup(self) -> Optional[dict]:
        """Check for and recover from interrupted transactions.

        Called on daemon/service startup.  Returns a recovery report
        dict if recovery was performed, or ``None`` if no recovery
        was needed.
        """
        report: Optional[dict] = None

        # Check for stale locks from crashed processes.
        try:
            stale_info = self._lock.check_stale_lock()
            if stale_info is not None:
                logger.warning(
                    "Stale lock detected from PID %s, recovering...",
                    stale_info.get("pid"),
                )
                report = self._lock.recover_stale_lock()
                logger.info("Stale lock recovery report: %s", report)
        except Exception as exc:
            logger.exception("Error during stale lock check: %s", exc)
            report = {
                "recovered": False,
                "error": "Stale lock check failed: {}".format(exc),
            }

        # Clean up stale ephemeral snapshots.
        try:
            cleaned = self._gc.cleanup_stale_ephemeral(
                active_transaction_ids=set(),
            )
            if cleaned:
                logger.info(
                    "Cleaned up %d stale ephemeral snapshot(s): %s",
                    len(cleaned), cleaned,
                )
                if report is None:
                    report = {}
                report["stale_ephemeral_cleaned"] = cleaned
        except Exception as exc:
            logger.exception(
                "Error during ephemeral snapshot cleanup: %s", exc,
            )
            if report is None:
                report = {}
            report["ephemeral_cleanup_error"] = str(exc)

        return report
