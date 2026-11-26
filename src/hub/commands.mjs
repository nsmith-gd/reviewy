// Slash command and context-menu definitions (design §8), as raw API JSON.
const STRING = 3;
const INTEGER = 4;
const BOOLEAN = 5;
const CHANNEL = 7;
const ATTACHMENT = 11;
const SUB = 1;
const GROUP = 2;
const TEXT_CHANNELS = [0, 5, 11, 12, 15]; // text, announcement, threads, forum

export const REVIEW_MENU_NAME = 'Review with Debrief';

export const COMMANDS = [
  {
    name: 'review',
    description: 'Review a video with your own Claude Code worker',
    options: [
      { type: STRING, name: 'url', description: 'YouTube, Google Drive or direct video link', required: false },
      { type: ATTACHMENT, name: 'file', description: 'Or attach the video', required: false },
      { type: STRING, name: 'context', description: 'What this review is about / what to focus on', required: false, max_length: 300 },
      { type: STRING, name: 'project', description: 'Project (glossary, departments, guidance)', required: false, autocomplete: true },
      { type: STRING, name: 'frames', description: 'Look at the picture too, or transcript only (cheaper)', required: false, choices: [{ name: 'on', value: 'on' }, { name: 'off (transcript only)', value: 'off' }] },
      { type: BOOLEAN, name: 'private', description: 'Send the result to your DMs instead of a thread', required: false },
    ],
  },
  { type: 3, name: REVIEW_MENU_NAME },
  {
    name: 'debrief',
    description: 'Debrief: pairing, status and settings',
    options: [
      { type: SUB, name: 'link', description: 'Pair your Discord account with the worker showing this code', options: [{ type: STRING, name: 'code', description: 'Six-character code printed by `debrief worker`', required: true, min_length: 6, max_length: 6 }] },
      { type: SUB, name: 'status', description: 'Your worker, its Whisper/GPU status, and your queue' },
      { type: SUB, name: 'forget', description: 'Unpair your workers and delete everything the hub holds about you' },
      {
        type: GROUP,
        name: 'pool',
        description: 'Let your worker review for people who have none online',
        options: [
          {
            type: SUB,
            name: 'join',
            description: 'Opt your worker in to reviewing for others',
            options: [
              { type: INTEGER, name: 'daily_cap', description: 'Most pool reviews per day (default 10)', required: false, min_value: 1, max_value: 200 },
              { type: BOOLEAN, name: 'this_server_only', description: 'Only serve this server (default: every server the bot is in)', required: false },
            ],
          },
          { type: SUB, name: 'leave', description: 'Stop reviewing for others' },
        ],
      },
      {
        type: GROUP,
        name: 'setup',
        description: 'Server settings (Manage Server)',
        options: [
          { type: SUB, name: 'show', description: 'Show this server\'s Debrief settings' },
          {
            type: SUB,
            name: 'project',
            description: 'Create or update a project',
            options: [
              { type: STRING, name: 'name', description: 'Project name, e.g. ZQuest', required: true, autocomplete: true, max_length: 50 },
              { type: STRING, name: 'glossary', description: 'Names and jargon, comma-separated (fed to Whisper and Claude)', required: false, max_length: 1500 },
              { type: STRING, name: 'departments', description: 'Areas, comma-separated (default: gameplay, art, audio, backend, other)', required: false, max_length: 300 },
              { type: STRING, name: 'guidance', description: 'House style and what the team cares about', required: false, max_length: 1500 },
              { type: STRING, name: 'language', description: 'Whisper language code, e.g. en, fr, auto', required: false, max_length: 8 },
              { type: CHANNEL, name: 'default_channel', description: 'Where review threads go when a command is used outside a text channel', required: false, channel_types: [0, 5] },
            ],
          },
          { type: SUB, name: 'remove-project', description: 'Delete a project', options: [{ type: STRING, name: 'name', description: 'Project', required: true, autocomplete: true }] },
          {
            type: SUB,
            name: 'channel',
            description: 'Bind a channel to a project and/or turn on auto-review',
            options: [
              { type: CHANNEL, name: 'channel', description: 'Channel', required: true, channel_types: TEXT_CHANNELS },
              { type: STRING, name: 'project', description: 'Project for reviews in this channel ("none" to unbind)', required: false, autocomplete: true },
              { type: BOOLEAN, name: 'auto_review', description: 'Review every video a paired reviewer posts here', required: false },
            ],
          },
          {
            type: SUB,
            name: 'transcripts',
            description: 'Who can see transcripts',
            options: [
              {
                type: STRING,
                name: 'visibility',
                description: 'Default: reviewer only',
                required: true,
                choices: [
                  { name: 'Attach transcript.txt in the thread', value: 'thread' },
                  { name: 'Anyone, via the Transcript button', value: 'button' },
                  { name: 'Reviewer only, via the Transcript button', value: 'reviewer' },
                ],
              },
            ],
          },
          {
            type: SUB,
            name: 'tracker',
            description: 'Send to tracker for a project (runs on the reviewer\'s worker with their own connectors)',
            options: [
              { type: STRING, name: 'project', description: 'Project', required: true, autocomplete: true },
              { type: BOOLEAN, name: 'enabled', description: 'Show the Send to tracker button', required: true },
              { type: STRING, name: 'kind', description: 'Tracker name, e.g. Jira, Linear, Notion', required: false, max_length: 30 },
              { type: STRING, name: 'project_key', description: 'Tracker project key, e.g. ZQ', required: false, max_length: 50 },
              { type: STRING, name: 'issue_type', description: 'Issue type, e.g. Task', required: false, max_length: 50 },
              { type: STRING, name: 'priorities', description: 'Which feedback to export (default high)', required: false, choices: [{ name: 'high only', value: 'high' }, { name: 'high and normal', value: 'high,normal' }, { name: 'all', value: 'high,normal,low' }] },
              { type: STRING, name: 'instructions', description: 'Extra instructions for ticket creation', required: false, max_length: 1000 },
            ],
          },
        ],
      },
    ],
  },
];
