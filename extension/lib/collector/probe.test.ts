import { describe, expect, it } from 'vitest';
import { accounts, createFakeInstagram, html, json } from '../testing/fake-instagram';
import { runProbe } from './probe';

const session = { viewerId: '1000', csrfToken: 'csrf' };

describe('runProbe', () => {
  it('passes when every endpoint answers with data', async () => {
    const fake = createFakeInstagram({ following: accounts('1', '2'), followers: accounts('2') });
    const report = await runProbe({ client: fake.client, session });
    expect(report.verdict).toBe('ok');
    expect(report.steps.map(step => step.ok)).toEqual([true, true, true, true, true]);
    expect(fake.requests).toHaveLength(5);
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

  it('describes what came back when the bulk check is refused', async () => {
    const fake = createFakeInstagram({
      following: accounts('1'),
      followers: accounts('1'),
      intercept: r => (r.path.endsWith('/show_many/') ? html('<html>nope</html>') : undefined),
    });
    const report = await runProbe({ client: fake.client, session });
    expect(report.verdict).toBe('degraded');
    const bulk = report.steps.find(step => step.name === 'Bulk friendship check')!;
    expect(bulk.ok).toBe(false);
    expect(bulk.notes.join(' ')).toMatch(/text\/html.*body: html/);
    expect(report.steps.find(step => step.name === 'Single friendship check')?.ok).toBe(true);
  });

  it('notes when the list cursor is a plain offset', async () => {
    const fake = createFakeInstagram({ following: accounts('1', '2', '3'), followingChunk: 2 });
    const report = await runProbe({ client: fake.client, session, pageSize: 50 });
    expect(report.steps[1]!.notes).toContain('cursor is a plain offset');
  });

  it('asks for the lists the same way a sync does', async () => {
    const fake = createFakeInstagram({
      following: accounts('1', '2', '3'),
      followers: accounts('1'),
      followingChunk: 1,
      orderBehavior: 'all-in-one',
    });
    const report = await runProbe({ client: fake.client, session });
    const listRequests = fake.requests.filter(r => /\/(following|followers)\/$/.test(r.path));
    expect(listRequests.every(r => r.params.get('order') === 'date_followed_latest')).toBe(true);
    expect(report.steps[1]!.notes).toContain('3 users on page 1 (3 raw)');
    expect(report.steps[1]!.notes).toContain('no next page cursor');
  });

  it('shows how many accounts Instagram hides from the following list', async () => {
    const fake = createFakeInstagram({ following: accounts('1'), hiddenFollowing: 6 });
    const report = await runProbe({ client: fake.client, session });
    expect(report.steps[1]!.notes).toContain('Instagram hides 6 accounts from this list');
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
