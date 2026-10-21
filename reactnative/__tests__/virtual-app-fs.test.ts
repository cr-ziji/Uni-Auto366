import fs from '../src/polyfills/node/fs';

describe('virtual /app file system', () => {
  it('reads a bundled ruleset as utf-8 text', () => {
    const text = fs.readFileSync('/app/rulesets/auto-boat/ruleset.json', 'utf-8');
    expect(typeof text).toBe('string');
    // eslint-disable-next-line no-console
    console.log('first 40 chars:', JSON.stringify(String(text).slice(0, 40)));
    expect(() => JSON.parse(String(text))).not.toThrow();
  });

  it('lists the bundled ruleset directories', () => {
    const names = fs.readdirSync('/app/rulesets');
    expect(names).toContain('auto-boat');
    expect(fs.statSync('/app/rulesets/auto-boat').isDirectory()).toBe(true);
  });

  it('reads the agreement markdown', () => {
    const text = fs.readFileSync('/app/resources/agreements/privacy.md', 'utf-8');
    expect(String(text).length).toBeGreaterThan(100);
  });
});
