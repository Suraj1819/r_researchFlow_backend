import { describe, it, expect } from '@jest/globals';
import request from 'supertest';
import app from '../src/app.js';

describe('GET /api/v1/health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('researchflow-api');
  });
});

describe('Auth guard', () => {
  it('rejects unauthenticated /me', async () => {
    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects unauthenticated project create', async () => {
    const res = await request(app).post('/api/v1/projects/drafts').send({ title: 'Test' });
    expect(res.status).toBe(401);
  });
});
