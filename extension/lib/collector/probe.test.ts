import { describe, expect, it } from 'vitest';
import { accounts, createFakeInstagram, json } from '../testing/fake-instagram';
import { runProbe } from './probe';

const session = { viewerId: '1000', csrfToken: 'csrf' };

describe('runProbe', () => {
  it('passes when every endpoint answers with data', async () => {
    const fake = createFakeInstagram({ following: accounts('1', '2'), followers: accounts('2') });
    const report = await runProbe({ client: fake.client, session });
    expect(report.verdict).toBe('ok');
    expect(report.steps.map(step => step.ok)).toEqual([true, true, true, true]);
    expect(fake.requests).toHaveLength(4);
  });

  it('fails when a list endpoint returns an empty first page despite a positive count', async () => {
    const fake = createFakeInstagram({ following: [], reportedFollowing: 300, followers: accounts('1') });
    const report = await runProbe({ client: fake.client, session });
    expect(report.verdict).toBe('failed');
    expect(report.steps[1]!.notes.join(' ')).toMatch(/looks blocked/);
  });

  it('is degraded when only the profile endpoint fails', async () => {
    const fake = createFakeInstagram({
      following: accounts('1'),
      intercept: r => (r.path.endsWith('/info/') ? json({ status: 'fail' }, 500) : undefined),
    });
    const report = await runProbe({ client: fake.client, session });
    expect(report.verdict).toBe('degraded');
  });

  it('does not touch the network when signed out', async () => {
    const fake = createFakeInstagram();
    const report = await runProbe({ client: fake.client, session: { viewerId: null, csrfToken: null } });
    expect(report.verdict).toBe('signed_out');
    expect(fake.requests).toHaveLength(0);
  });

  it('keeps usernames and ids out of the report', async () => {
    const fake = createFakeInstagram({
      following: [{ pk: '424242', username: 'secret_name' }],
      followers: [{ pk: '434343', username: 'other_secret' }],
    });
    const text = JSON.stringify(await runProbe({ client: fake.client, session }));
    expect(text).not.toMatch(/secret_name|other_secret|424242|434343/);
  });
});
