import { describe, it, expect, vi } from 'vitest';
import {
  isSupabaseDirectUrl,
  parseSupabaseDirectUrl,
  buildSupabasePoolerUrl,
  probeSupabaseRegion,
  resolveSupabaseUrl,
} from '../src/db/supabase.js';
import pg from 'pg';

describe('Supabase Connection Utilities', () => {
  describe('isSupabaseDirectUrl', () => {
    it('identifies direct Supabase URLs', () => {
      expect(
        isSupabaseDirectUrl(
          'postgresql://postgres:pass@db.bgcfmmlrhmvoojuydhdj.supabase.co:5432/postgres'
        )
      ).toBe(true);
      expect(
        isSupabaseDirectUrl(
          'postgres://postgres:pass@db.xyz123.supabase.co/postgres'
        )
      ).toBe(true);
      expect(
        isSupabaseDirectUrl(
          'postgres://postgres:pass@db.project_ref.supabase.net/db'
        )
      ).toBe(true);
    });

    it('returns false for pooler and standard URLs', () => {
      expect(
        isSupabaseDirectUrl(
          'postgresql://postgres.bgcfmmlrhmvoojuydhdj:pass@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'
        )
      ).toBe(false);
      expect(isSupabaseDirectUrl('postgresql://postgres:pass@localhost:5432/mydb')).toBe(false);
      expect(isSupabaseDirectUrl('mongodb://user:pass@localhost:27017/mydb')).toBe(false);
      expect(isSupabaseDirectUrl('')).toBe(false);
    });
  });

  describe('parseSupabaseDirectUrl', () => {
    it('correctly parses direct Supabase URLs', () => {
      const parsed = parseSupabaseDirectUrl(
        'postgresql://postgres:secret%23pass@db.bgcfmmlrhmvoojuydhdj.supabase.co:5432/my_db?sslmode=require'
      );
      expect(parsed).not.toBeNull();
      expect(parsed?.projectRef).toBe('bgcfmmlrhmvoojuydhdj');
      expect(parsed?.username).toBe('postgres');
      expect(parsed?.password).toBe('secret#pass');
      expect(parsed?.database).toBe('my_db');
      expect(parsed?.port).toBe('5432');
      expect(parsed?.search).toBe('?sslmode=require');
    });

    it('returns null for non-direct Supabase URLs', () => {
      expect(parseSupabaseDirectUrl('postgresql://localhost:5432/postgres')).toBeNull();
    });
  });

  describe('buildSupabasePoolerUrl', () => {
    it('constructs correct pooler connection string with user.ref format', () => {
      const pooler = buildSupabasePoolerUrl({
        region: 'ap-northeast-1',
        projectRef: 'bgcfmmlrhmvoojuydhdj',
        username: 'postgres',
        password: 'myPassword123!',
        database: 'postgres',
        port: 5432,
      });

      expect(pooler).toBe(
        'postgresql://postgres.bgcfmmlrhmvoojuydhdj:myPassword123!@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'
      );
    });

    it('preserves query parameters if present', () => {
      const pooler = buildSupabasePoolerUrl({
        region: 'us-east-1',
        projectRef: 'abc123ref',
        username: 'postgres',
        password: 'pass',
        database: 'postgres',
        search: '?sslmode=require',
      });

      expect(pooler).toBe(
        'postgresql://postgres.abc123ref:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require'
      );
    });
  });

  describe('probeSupabaseRegion & resolveSupabaseUrl', () => {
    it('returns null when URL is not a direct Supabase URL', async () => {
      const result = await resolveSupabaseUrl('postgresql://user:pass@localhost:5432/db');
      expect(result).toBeNull();
    });

    it('resolves region when pooler responds successfully', async () => {
      const mockClient = {
        on: vi.fn(),
        connect: vi.fn().mockImplementation(function (this: any) {
          if (this.connectionString.includes('aws-0-ap-northeast-1.pooler.supabase.com')) {
            return Promise.resolve();
          }
          const err: any = new Error('tenant/user not found');
          return Promise.reject(err);
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const spy = vi.spyOn(pg, 'Client').mockImplementation(function (opts: any) {
        return {
          ...mockClient,
          connectionString: opts?.connectionString,
        } as any;
      });

      const result = await resolveSupabaseUrl(
        'postgresql://postgres:secret@db.bgcfmmlrhmvoojuydhdj.supabase.co:5432/postgres'
      );

      expect(result).not.toBeNull();
      expect(result?.region).toBe('ap-northeast-1');
      expect(result?.poolerUrl).toContain('aws-0-ap-northeast-1.pooler.supabase.com');
      expect(result?.poolerUrl).toContain('postgres.bgcfmmlrhmvoojuydhdj');

      spy.mockRestore();
    });
  });
});
