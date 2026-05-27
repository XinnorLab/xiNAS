import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestIdMiddleware } from '../../api/middleware/request-id.js';
import { errorMiddleware } from '../../api/middleware/error.js';
import { ApiException } from '../../api/errors.js';

function appWith() {
  const app = express();
  app.use(requestIdMiddleware());
  app.get('/api-throw', () => {
    throw new ApiException('NOT_FOUND', 'no such share', { id: 's1' });
  });
  app.get('/plain-throw', () => {
    throw new Error('boom');
  });
  app.use(errorMiddleware());
  return app;
}

describe('errorMiddleware', () => {
  it('translates ApiException into envelope error with mapped status', async () => {
    const res = await request(appWith()).get('/api-throw');
    expect(res.status).toBe(404);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].code).toBe('NOT_FOUND');
    expect(res.body.errors[0].message).toBe('no such share');
    expect(res.body.errors[0].details).toEqual({ id: 's1' });
  });

  it('translates a plain Error into INTERNAL 500 with the message', async () => {
    const res = await request(appWith()).get('/plain-throw');
    expect(res.status).toBe(500);
    expect(res.body.errors[0].code).toBe('INTERNAL');
    expect(res.body.errors[0].message).toMatch(/boom/);
  });
});
