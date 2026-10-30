import { describe, it, expect } from 'vitest';
import { resolveApiBase } from './session';

describe('Frontend API URL Resolution (resolveApiBase)', () => {
  it('defaults to /api when undefined, empty, or whitespace', () => {
    expect(resolveApiBase(undefined)).toBe('/api');
    expect(resolveApiBase('')).toBe('/api');
    expect(resolveApiBase('   ')).toBe('/api');
  });

  it('preserves /api and trims trailing slashes for relative paths', () => {
    expect(resolveApiBase('/api')).toBe('/api');
    expect(resolveApiBase('/api/')).toBe('/api');
    expect(resolveApiBase('api')).toBe('/api');
  });

  it('normalizes absolute URLs by appending /api if omitted', () => {
    expect(resolveApiBase('https://rapidaid-api.onrender.com')).toBe('https://rapidaid-api.onrender.com/api');
    expect(resolveApiBase('https://rapidaid-api.onrender.com/')).toBe('https://rapidaid-api.onrender.com/api');
    expect(resolveApiBase('http://localhost:5000')).toBe('http://localhost:5000/api');
  });

  it('preserves absolute URLs that already include /api and strips trailing slashes', () => {
    expect(resolveApiBase('https://rapidaid-api.onrender.com/api')).toBe('https://rapidaid-api.onrender.com/api');
    expect(resolveApiBase('https://rapidaid-api.onrender.com/api/')).toBe('https://rapidaid-api.onrender.com/api');
  });
});

