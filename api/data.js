// GET /api/data
// Returns all PRD pages linked from Linear milestones, with live progress data.

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

async function notionGet(path) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  return res.json();
}

function extractNotionPageId(text) {
  return text?.match(/notion\.so\/([a-f0-9]{32})/)?.[1] ?? null;
}

// Parse the "synced Apr 1, 2026" line out of the callout text
function parseLastSynced(richText) {
  const text = richText?.[0]?.plain_text ?? '';
  const match = text.match(/synced\s+(.+?)\n/);
  return match ? match[1] : null;
}

function overallStatus(avgProgress) {
  if (avgProgress >= 100) return 'Complete';
  if (avgProgress > 0) return 'In Progress';
  return 'Not Started';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const projectId = process.env.LINEAR_PROJECT_ID;
    if (!projectId) return res.status(500).json({ error: 'LINEAR_PROJECT_ID not set' });

    // 1. Fetch all milestones for the project
    const data = await linearGql(
      `query($id: String!) {
        project(id: $id) {
          name
          url
          projectMilestones {
            nodes { id name description progress }
          }
        }
      }`,
      { id: projectId }
    );

    const project = data.project;
    const milestones = project.projectMilestones.nodes;

    // 2. Group milestones by Notion page ID
    const prdMap = new Map();
    for (const m of milestones) {
      const notionPageId = extractNotionPageId(m.description);
      if (!notionPageId) continue;
      if (!prdMap.has(notionPageId)) {
        prdMap.set(notionPageId, { notionPageId, milestones: [] });
      }
      prdMap.get(notionPageId).milestones.push({
        id: m.id,
        name: m.name,
        progress: Math.round(m.progress),
      });
    }

    // 3. Fetch Notion page title + last synced time for each PRD
    const prds = await Promise.all(
      Array.from(prdMap.values()).map(async (prd) => {
        // Page title
        const page = await notionGet(`/pages/${prd.notionPageId}`);
        const title =
          page.properties?.title?.title?.[0]?.plain_text ?? 'Untitled';

        // Last synced — read the existing 🔄 callout if present
        const blocks = await notionGet(`/blocks/${prd.notionPageId}/children`);
        const syncBlock = blocks.results?.find(
          (b) => b.type === 'callout' && b.callout?.icon?.emoji === SYNC_EMOJI
        );
        const lastSynced = syncBlock
          ? parseLastSynced(syncBlock.callout?.rich_text)
          : null;

        const avgProgress = Math.round(
          prd.milestones.reduce((s, m) => s + m.progress, 0) /
            prd.milestones.length
        );

        return {
          notionPageId: prd.notionPageId,
          notionUrl: `https://www.notion.so/${prd.notionPageId}`,
          title,
          lastSynced,
          avgProgress,
          status: overallStatus(avgProgress),
          milestones: prd.milestones.sort((a, b) => b.progress - a.progress),
        };
      })
    );

    // Sort PRDs: in-progress first, then not started, then complete
    const order = { 'In Progress': 0, 'Not Started': 1, Complete: 2 };
    prds.sort((a, b) => order[a.status] - order[b.status]);

    res.json({ projectName: project.name, projectUrl: project.url, prds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
