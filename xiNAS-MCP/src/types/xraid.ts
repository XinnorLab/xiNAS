/**
 * xiRAID domain types derived from gRPC response shapes.
 * These are the parsed JSON structures returned by xiRAID gRPC RPCs.
 */

export interface RaidInfo {
  name: string;
  uuid?: string;
  level: string;
  state: string;
  size?: string;
  members?: DriveSlot[];
  init_progress?: number;
  recon_progress?: number;
  degraded?: boolean;
  memory_limit?: number;
  strip_size?: number;
  block_size?: number;
  sparepool?: string;
}

export interface DriveSlot {
  slot: number;
  path: string;
  state: string;
  faulty_count?: number;
  size?: string;
}

export interface PoolInfo {
  name: string;
  drives: string[];
  active: boolean;
}

export interface LicenseInfo {
  valid: boolean;
  expiry?: string;
  product?: string;
  features?: string[];
  node_count?: number;
}

export interface SettingsAuthInfo {
  host: string;
  port: number;
}

export interface SettingsScannerInfo {
  smart_polling_interval?: number;
  led_enabled?: number;
  scanner_polling_interval?: number;
}

export interface SettingsClusterInfo {
  raid_autostart?: number;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  component?: string;
}
