#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Parse CLI arguments
const { values } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    pr: { type: 'string', short: 'p' },
    project: { type: 'string', default: 'xiNAS' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!values.input) {
  console.error('Usage: node tq-publish.mjs --input <json-file> [--pr <number>] [--project <name>] [--dry-run]');
  process.exit(1);
}

const accessToken = process.env.TQ_ACCESS_TOKEN;
if (!accessToken && !values['dry-run']) {
  console.error('Error: TQ_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

// Read and parse input JSON
const raw = readFileSync(values.input, 'utf-8');
const data = JSON.parse(raw);

if (!data.testPlan || !data.testCases) {
  console.error('Error: JSON must contain "testPlan" and "testCases" fields');
  process.exit(1);
}

const { testPlan, testCases } = data;

// Dry-run mode: just validate and summarize
if (values['dry-run']) {
  console.log('=== DRY RUN ===');
  console.log(`Test Plan: ${testPlan.title}`);
  console.log(`Scope: ${testPlan.scope}`);
  console.log(`Risks: ${testPlan.risks?.length || 0}`);
  console.log(`Strategy: ${testPlan.strategy?.join(', ')}`);
  console.log(`Test Cases: ${testCases.length}`);
  const byPriority = { P0: 0, P1: 0, P2: 0 };
  testCases.forEach(tc => { byPriority[tc.priority] = (byPriority[tc.priority] || 0) + 1; });
  console.log(`  P0: ${byPriority.P0}, P1: ${byPriority.P1}, P2: ${byPriority.P2}`);
  const components = [...new Set(testCases.map(tc => tc.component))];
  console.log(`Components: ${components.join(', ')}`);
  console.log('=== Validation passed ===');
  process.exit(0);
}

// --- TestQuality REST API Integration ---
const TQ_API_BASE = 'https://api.testquality.com';

async function tqFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${TQ_API_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`TQ API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function findOrCreateProject(name) {
  const resp = await tqFetch('/api/project');
  const projects = Array.isArray(resp) ? resp : (resp.data || []);
  const existing = projects.find(p => p.name === name);
  if (existing) return existing;
  return tqFetch('/api/project', 'POST', { name });
}

async function createTestPlan(projectId, plan) {
  return tqFetch('/api/plan', 'POST', {
    project_id: projectId,
    name: plan.title,
    description: [
      `**Scope:** ${plan.scope}`,
      `**Strategy:** ${plan.strategy?.join(', ')}`,
      `**Environment:** ${plan.environment}`,
      `**Entry Criteria:** ${plan.entryCriteria}`,
      `**Exit Criteria:** ${plan.exitCriteria}`,
    ].join('\n\n'),
  });
}

async function createTestSuite(projectId, planId, name) {
  const suite = await tqFetch('/api/suite', 'POST', {
    project_id: projectId,
    name,
  });
  // Link suite to plan
  await tqFetch(`/api/plan/${planId}/suite/${suite.id}`, 'PUT', {});
  return suite;
}

async function createTestCase(projectId, suiteId, tc) {
  const test = await tqFetch('/api/test', 'POST', {
    project_id: projectId,
    name: `${tc.id}: ${tc.title}`,
    precondition: tc.preconditions,
    description: [
      `**Priority:** ${tc.priority}`,
      `**Type:** ${tc.type}`,
      `**Input Data:** ${tc.inputData}`,
      `**Expected Result:** ${tc.expectedResult}`,
      `**Observability:** ${tc.observability}`,
      `**References:** ${tc.references?.join(', ')}`,
    ].join('\n'),
  });

  // Link test to suite
  await tqFetch(`/api/suite/${suiteId}/test/${test.id}`, 'PUT', {});

  // Add steps
  for (const step of tc.steps || []) {
    await tqFetch('/api/step', 'POST', {
      project_id: projectId,
      test_id: test.id,
      step: step.action,
      expected_result: step.expected,
      sequence: step.step,
    });
  }

  return test;
}

async function main() {
  try {
    const project = await findOrCreateProject(values.project);
    console.log(`Project: ${project.name} (ID: ${project.id})`);

    const plan = await createTestPlan(project.id, testPlan);
    console.log(`Test Plan created: ${plan.name} (ID: ${plan.id})`);

    // Group test cases by component
    const byComponent = {};
    for (const tc of testCases) {
      const comp = tc.component || 'general';
      if (!byComponent[comp]) byComponent[comp] = [];
      byComponent[comp].push(tc);
    }

    let totalCreated = 0;
    for (const [component, cases] of Object.entries(byComponent)) {
      const suite = await createTestSuite(project.id, plan.id, component);
      console.log(`  Suite: ${component} (${cases.length} cases)`);
      for (const tc of cases) {
        await createTestCase(project.id, suite.id, tc);
        totalCreated++;
      }
    }

    const byPriority = { P0: 0, P1: 0, P2: 0 };
    testCases.forEach(tc => { byPriority[tc.priority] = (byPriority[tc.priority] || 0) + 1; });

    const summary = {
      planId: plan.id,
      planName: plan.name,
      totalCases: totalCreated,
      p0: byPriority.P0,
      p1: byPriority.P1,
      p2: byPriority.P2,
      components: Object.keys(byComponent),
      risks: testPlan.risks?.map(r => `${r.severity}: ${r.description}`) || [],
    };

    console.log('\n=== Published to TestQuality ===');
    console.log(JSON.stringify(summary, null, 2));

    // Output for GitHub Action
    if (process.env.GITHUB_OUTPUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.GITHUB_OUTPUT, `tq_summary=${JSON.stringify(summary)}\n`);
    }
  } catch (err) {
    console.error('Failed to publish to TestQuality:', err.message);
    process.exit(1);
  }
}

main();
