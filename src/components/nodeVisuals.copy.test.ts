import { describe, expect, it } from 'vitest';
import { whatIsKind } from './nodeVisuals';

describe('whatIsKind', () => {
  it('picks the article by sound', () => {
    expect(whatIsKind('edgecompute')).toBe('What is an Edge compute?');
    expect(whatIsKind('apigateway')).toBe('What is an API gateway?');
    expect(whatIsKind('autoscaler')).toBe('What is an Autoscaler?');
    expect(whatIsKind('objectstore')).toBe('What is an Object storage?');
    expect(whatIsKind('cdn')).toBe('What is a CDN?');
    expect(whatIsKind('db')).toBe('What is a Database?');
  });

  it('uses "are" for the one plural name', () => {
    expect(whatIsKind('replica')).toBe('What are Read replicas?');
  });
});
