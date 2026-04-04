// POST /api/sync
// Body: { notionPageId: "32-char-id" }
// Queries Linear for all milestones linked to this Notion page,
// then writes/updates the 🔄 progress callout on that page.

const NOTION_VERSION = '2022-06-28';
const SYNC_EMOJI = '🔄';

async function linearGql(query, variables = {}) {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: process.env.LINEAR_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

async function notionReq(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function extractNotionPageId(text) {
  return text?.match(/notion\.so\/([a-f0-9]{32})/)?.[1] ?? null;
}

function progressBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

function statusLabel(progress) {
  if (progress >= 100) return '✅ Complete';
  if (progress > 0) return '🔄 In Progress';
  return '⬜ Not Started';
}

function buildCalloutRichText(milestones) {
  const date = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });

  const richText = [
    {
      type: 'text',
      text: { content: `Linear progress  ·  synced ${date}\n\n` },
      annotations: { italic: true, color: 'gray' },
    },
  ];

  for (const m of milestones) {
    const pct = Math.round(m.progress);
    richText.push(
      { type: 'text', text: { content: m.name }, annotations: { bold: true } },
      {
        type: 'text',
        text: { content: `   ${progressBar(pct)} ${pct}%   ${statusLabel(m.progress)}\n` },
      }
    );
  }

  return richText;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { notionPageId } = req.body ?? {};
  if (!notionPageId) return res.status(400).json({ error: 'notionPageId required' });

  try {
    const projectId = process.env.LINEAR_PROJECT_ID;

    // Get all milestones for the project
    const data = await linearGql(
      `query($id: String!) {
        project(id: $id) {
          projectMilestones { nodes { id name description progress } }
        }
      }`,
      { id: projectId }
    );

    const allMilestones = data.project.projectMilestones.nodes;

    // Keep only those that link to this Notion page
    const linked = allMilestones
      .filter((m) => extractNotionPageId(m.description) === notionPageId)
      .sort((a, b) => b.progress - a.progress);

    if (linked.length === 0) {
      return res.status(404).json({ error: 'No milestones found linking to this Notion page' });
    }

    // Build the callout content
    const richText = buildCalloutRichText(linked);
    const calloutBody = {
      icon: { type: 'emoji', emoji: SYNC_EMOJI },
      rich_text: richText,
      color: 'gray_background',
    };

    // Find existing sync block on the page
    const blocks = await notionReq('GET', `/blocks/${notionPageId}/children`);
    const existing = blocks.results?.find(
      (b) => b.type === 'callout' && b.callout?.icon?.emoji === SYNC_EMOJI
    );

    if (existing) {
      await notionReq('PATCH', `/blocks/${existing.id}`, { callout: calloutBody });
    } else {
      await notionReq('PATCH', `/blocks/${notionPageId}/children`, {
        children: [{ object: 'block', type: 'callout', callout: calloutBody }],
      });
    }

    const date = new Date().toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    res.json({
      ok: true,
      lastSynced: date,
      milestones: linked.map((m) => ({ name: m.name, progress: Math.round(m.progress) })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
