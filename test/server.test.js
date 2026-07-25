const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiscordEmbed, buildDiscordPayload, buildTranscript, buildDiscordAuthHeader, parseDiscordResponse } = require('../server');

test('buildDiscordEmbed includes the report metadata and action buttons', () => {
  const embed = buildDiscordEmbed({
    reportId: 'ABC123',
    username: 'Steve',
    type: 'Griefing',
    description: 'Destroyed my base',
    email: 'reporter@example.com',
  });

  assert.equal(embed.title, 'New report submitted');
  assert.equal(embed.color, 0xf59e0b);
  assert.equal(embed.fields[0].name, 'Reporter');
  assert.equal(embed.fields[0].value, 'Steve');
  assert.equal(embed.fields[2].name, 'Email');
  assert.equal(embed.fields[2].value, 'reporter@example.com');
});

test('buildTranscript records the report lifecycle in order', () => {
  const transcript = buildTranscript({
    reportId: 'ABC123',
    username: 'Steve',
    type: 'Griefing',
    description: 'Destroyed my base',
    email: 'reporter@example.com',
    actions: [
      { action: 'claimed', actor: 'Mod Jane' },
      { action: 'resolved', actor: 'Mod Jane', reason: 'Issue handled' },
    ],
  });

  assert.match(transcript, /Report ID: ABC123/);
  assert.match(transcript, /claimed/);
  assert.match(transcript, /resolved/);
  assert.match(transcript, /Issue handled/);
});

test('buildDiscordAuthHeader preserves an existing auth prefix and adds one for raw tokens', () => {
  assert.equal(buildDiscordAuthHeader('abc123'), 'Bot abc123');
  assert.equal(buildDiscordAuthHeader('Bot abc123'), 'Bot abc123');
  assert.equal(buildDiscordAuthHeader('Bearer abc123'), 'Bearer abc123');
});

test('buildDiscordPayload returns a Discord-compatible embed payload', () => {
  const payload = buildDiscordPayload({
    reportId: 'ABC123',
    username: 'Steve',
    type: 'Griefing',
    description: 'Destroyed my base',
    email: 'reporter@example.com',
  });

  assert.equal(payload.content, 'New report submitted from CosmixMC');
  assert.equal(payload.embeds[0].title, 'New report submitted');
  assert.equal(payload.embeds[0].fields[0].name, 'Reporter');
  assert.equal(payload.components[0].type, 1);
});

test('parseDiscordResponse returns an empty object for successful empty bodies', async () => {
  const response = new Response('', { status: 200 });
  const parsed = await parseDiscordResponse(response);
  assert.deepEqual(parsed, {});
});
