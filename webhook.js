// Linear → Notion Progress Sync
// Deploy as: Vercel serverless function (api/webhook.js)
// Triggers on: Linear issue state changes + milestone updates
// Effect: Updates a 🔄 callout in the linked Notion PRD with live milestone progress

import crypto from 'crypto';

const NOTION_VERSION = '2022-06-28';
const SYNC_EMOJI = '🔄';

// ─── API helpers ─────────────────────────────────────────────────────────────

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

async function notion(method, path, body) {
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

// ─── Linear queries ───────────────────────────────────────────────────────────

async function getMilestoneFromIssue(issueId) {
  const data = await linearGql(
    `query($id: String!) {
      issue(id: $id) {
        projectMilestone { id name description progress project { id } }
      }
    }`,
    { id: issueId }
  );
  return data.issue?.projectMilestone ?? null;
}

async function getMilestoneById(milestoneId) {
  const data = await linearGql(
    `query($id: String!) {
      projectMilestone(id: $id) {
        id name description progress project { id }
      }
    }`,
    { id: milestoneId }
  );
  return data.projectMilestone ?? null;
}

async function getAllMilestonesForProject(projectId) {
  const data = await linearGql(
    `query($id: String!) {
      project(id: $id) {
        projectMilestones { nodes { id name description progress } }
      }
    }`,
    { id: projectId }
  );
  return data.project?.projectMilestones?.nodes ?? [];
}

// ─── Notion helpers ───────────────────────────────────────────────────────────

// Extract the 32-char Notion page ID from a notion.so URL
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

// Build the rich_text array for the callout block
function buildCalloutContent(milestones) {
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

// Find an existing sync callout on the page, or return null
async function findSyncBlock(pageId) {
  const { results } = await notion('GET', `/blocks/${pageId}/children`);
  return results?.find(
    (b) => b.type === 'callout' && b.callout?.icon?.emoji === SYNC_EMOJI
  ) ?? null;
}

async function upsertProgressCallout(pageId, milestones) {
  const richText = buildCalloutContent(milestones);
  const calloutBody = {
    icon: { type: 'emoji', emoji: SYNC_EMOJI },
    rich_text: richText,
    color: 'gray_background',
  };

  const existing = await findSyncBlock(pageId);

  if (existing) {
    // Update in place — block stays where the PM put it
    await notion('PATCH', `/blocks/${existing.id}`, { callout: calloutBody });
  } else {
    // First run: append to the page (PM can drag it to the top once)
    await notion('PATCH', `/blocks/${pageId}/children`, {
      children: [{ object: 'block', type: 'callout', callout: calloutBody }],
    });
  }
}

// ─── Webhook signature verification ──────────────────────────────────────────

function verifySignature(rawBody, signature) {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return true; // skip in dev if not set
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = JSON.stringify(req.body); // Vercel parses JSON automatically
  const sig = req.headers['linear-signature'] ?? '';
  if (!verifySignature(rawBody, sig)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  const { type, action, data } = req.body;

  // We care about:
  //   Issue:update — a ticket was moved to a new state (e.g., closed)
  //   ProjectMilestone:create/update — milestone progress or status changed
  let milestone = null;

  if (type === 'Issue' && action === 'update') {
    milestone = await getMilestoneFromIssue(data.id);
  } else if (type === 'ProjectMilestone') {
    milestone = await getMilestoneById(data.id);
  }

  if (!milestone?.description) {
    return res.json({ skipped: 'no relevant milestone' });
  }

  const notionPageId = extractNotionPageId(milestone.description);
  if (!notionPageId) {
    return res.json({ skipped: 'no notion url in milestone description' });
  }

  // Get ALL milestones for this project, then filter to those linking this PRD.
  // This ensures the callout shows aggregate progress across all linked milestones.
  const allMilestones = await getAllMilestonesForProject(milestone.project.id);
  const linkedMilestones = allMilestones
    .filter((m) => extractNotionPageId(m.description) === notionPageId)
    .sort((a, b) => b.progress - a.progress); // highest progress first

  await upsertProgressCallout(notionPageId, linkedMilestones);

  console.log(`Updated Notion page ${notionPageId} with ${linkedMilestones.length} milestone(s)`);
  return res.json({ ok: true, notionPageId, milestones: linkedMilestones.map((m) => m.name) });
}
