import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MCP_APP_MIME_TYPE,
  MCP_UI_EXTENSION,
  RAID_CREATE_APP_URI,
  listAppResources,
  mcpUiExtensionCapability,
  readAppResource,
} from '../../api/mcp/apps.js';
import { listTools } from '../../api/mcp/dispatch.js';
import { raidCreateAppConfig } from '../../api/routes/storage.js';
import {
  BLOCK_SIZES,
  LEVELS,
  LEVEL_CONSTRAINTS,
  STRIP_SIZES_KIB,
} from '../../lib/xiraid/schema.js';
import { ADMIN_TOKEN, VIEWER_TOKEN, buildTestApp } from './_helpers.js';

describe('MCP RAID Create App (S18)', () => {
  it('links the launch tool to the declared MCP App resource', () => {
    const tool = listTools().find((candidate) => candidate.name === 'mcp_apps.raid_create');
    expect(tool?._meta?.ui.resourceUri).toBe(RAID_CREATE_APP_URI);
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(listAppResources()).toEqual([
      {
        uri: RAID_CREATE_APP_URI,
        name: 'xiNAS RAID Create',
        description: 'Interactive xiRAID array creation wizard',
        mimeType: MCP_APP_MIME_TYPE,
      },
    ]);
    expect(mcpUiExtensionCapability()).toEqual({ mimeTypes: [MCP_APP_MIME_TYPE] });
    expect(MCP_UI_EXTENSION).toBe('io.modelcontextprotocol/ui');
  });

  it('serves only the closed UI resource and never resolves arbitrary URIs', async () => {
    const result = await readAppResource(RAID_CREATE_APP_URI);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(result.contents[0]?.text).toContain('<!doctype html>');
    expect(result.contents[0]?._meta.ui).toEqual({
      csp: { connectDomains: [], resourceDomains: [] },
      prefersBorder: true,
    });
    await expect(readAppResource('ui://xinas/../../etc/passwd')).rejects.toThrow(
      'unknown MCP App resource',
    );
  });

  it('generates the form choices from the canonical xiRAID tables', () => {
    const value = raidCreateAppConfig() as {
      levels: string[];
      strip_sizes_kib: number[];
      block_sizes: number[];
      constraints: Record<string, { min_drives: number; even_members: boolean }>;
    };
    expect(value.levels).toEqual([...LEVELS]);
    expect(value.strip_sizes_kib).toEqual([...STRIP_SIZES_KIB]);
    expect(value.block_sizes).toEqual([...BLOCK_SIZES]);
    for (const level of LEVELS) {
      expect(value.constraints[level]?.min_drives).toBe(LEVEL_CONSTRAINTS[level].minDrives);
    }
    expect(value.constraints.raid10?.even_members).toBe(true);
  });

  describe('REST bootstrap RBAC', () => {
    let setup: Awaited<ReturnType<typeof buildTestApp>>;

    beforeEach(async () => {
      setup = await buildTestApp();
    });

    afterEach(async () => {
      await setup.cleanup();
    });

    it('allows admin and rejects viewer', async () => {
      const admin = await request(setup.app)
        .get('/api/v1/mcp/apps/raid-create')
        .set('Authorization', ADMIN_TOKEN);
      expect(admin.status).toBe(200);
      expect(admin.body.result).toMatchObject({
        app: 'raid_create',
        resource_uri: RAID_CREATE_APP_URI,
        defaults: { level: 'raid6', strip_size_kib: 128, block_size: 4096 },
      });

      const viewer = await request(setup.app)
        .get('/api/v1/mcp/apps/raid-create')
        .set('Authorization', VIEWER_TOKEN);
      expect(viewer.status).toBe(401);
    });
  });
});
