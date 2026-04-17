// GET /api/cycles
// Returns current and upcoming Linear cycle data, matched to Notion Sprint Review pages.

const NOTION_VERSION = '2022-06-28';
const SPRINT_REVIEWS_DB_ID = 'a600c208b1984178ae39036a68e3eda0';

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

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const projectId = process.env.LINEAR_PROJECT_ID;
    if (!projectId) return res.status(500).json({ error: 'LINEAR_PROJECT_ID not set' });

    // 1. Get the team linked to this project
    const projectData = await linearGql(
      `query($id: String!) {
        project(id: $id) {
          teams { nodes { id name } }
        }
      }`,
      { id: projectId }
    );
    const teamId = projectData.project?.teams?.nodes?.[0]?.id;
    if (!teamId) return res.status(500).json({ error: 'No team found for project' });

    // 2. Get recent + upcoming cycles for this team
    const cycleData = await linearGql(
      `query($teamId: String!) {
        team(id: $teamId) {
          cycles(orderBy: startsAt, last: 10) {
            nodes {
              id number name startsAt endsAt progress
              issueCountHistory completedIssueCountHistory canceledIssueCountHistory
            }
          }
        }
      }`,
      { teamId }
    );

    const now = new Date();
    const cycles = cycleData.team?.cycles?.nodes ?? [];

    // Find active cycle (today falls within its dates)
    const active = cycles.find(
      (c) => new Date(c.startsAt) <= now && new Date(c.endsAt) >= now
    );

    // Find the next upcoming cycle (starts after today)
    const upcoming = cycles
      .filter((c) => new Date(c.startsAt) > now)
      .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0] ?? null;

    // 3. Query Notion Sprint Reviews database
    const dbRes = await notionReq('POST', `/databases/${SPRINT_REVIEWS_DB_ID}/query`, {
      sorts: [{ property: 'Cycle', direction: 'descending' }],
    });
    const notionPages = dbRes.results ?? [];

    // Match by "Cycle N" in the page title
    function findNotionPage(cycleNumber) {
      return notionPages.find((p) => {
        const title = p.properties?.Name?.title?.[0]?.plain_text ?? '';
        return title.includes(`Cycle ${cycleNumber}`);
      }) ?? null;
    }

    // Build cycle summary object
    function summarize(cycle, notionPage) {
      if (!cycle) return null;

      // Use last entry in history arrays for current totals
      const history = cycle.issueCountHistory ?? [];
      const completedHistory = cycle.completedIssueCountHistory ?? [];
      const cancelledHistory = cycle.canceledIssueCountHistory ?? [];
      const total = history[history.length - 1] ?? 0;
      const done = completedHistory[completedHistory.length - 1] ?? 0;
      const cancelled = cancelledHistory[cancelledHistory.length - 1] ?? 0;
      const progress = Math.round((cycle.progress ?? 0) * 100);

      const pageId = notionPage?.id?.replace(/-/g, '') ?? null;

      return {
        id: cycle.id,
        number: cycle.number,
        name: cycle.name || `Cycle ${cycle.number}`,
        startDate: formatDate(cycle.startsAt),
        endDate: formatDate(cycle.endsAt),
        progress,
        total,
        done,
        cancelled,
        notionPageId: pageId,
        notionUrl: pageId ? `https://www.notion.so/${pageId}` : null,
      };
    }

    res.json({
      current: summarize(active, active ? findNotionPage(active.number) : null),
      upcoming: summarize(upcoming, upcoming ? findNotionPage(upcoming.number) : null),
    });
  } catch (err) {
    console.error('[api/cycles]', err);
    res.status(500).json({ error: err.message });
  }
}
