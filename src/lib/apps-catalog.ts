// Catalog of known and connected apps/integrations for # autocomplete.

export interface AppCatalogItem {
  slug: string;
  name: string;
  description: string;
  domain?: string | null;
  logo?: string | null;
  connected?: boolean;
}

export const POPULAR_APPS: AppCatalogItem[] = [
  { slug: "slack", name: "Slack", description: "Team communication and channels", domain: "slack.com" },
  { slug: "github", name: "GitHub", description: "Repositories, issues, and pull requests", domain: "github.com" },
  { slug: "linear", name: "Linear", description: "Issue tracking and project management", domain: "linear.app" },
  { slug: "notion", name: "Notion", description: "Docs, wikis, and knowledge bases", domain: "notion.so" },
  { slug: "sentry", name: "Sentry", description: "Error tracking and performance monitoring", domain: "sentry.io" },
  { slug: "discord", name: "Discord", description: "Chat and community servers", domain: "discord.com" },
  { slug: "gmail", name: "Gmail", description: "Email and communication", domain: "gmail.com" },
  { slug: "google-calendar", name: "Google Calendar", description: "Scheduling and events", domain: "calendar.google.com" },
  { slug: "google-sheets", name: "Google Sheets", description: "Spreadsheets and data", domain: "sheets.google.com" },
  { slug: "google-docs", name: "Google Docs", description: "Document collaboration", domain: "docs.google.com" },
  { slug: "google-drive", name: "Google Drive", description: "Cloud file storage", domain: "drive.google.com" },
  { slug: "posthog", name: "PostHog", description: "Product analytics and session recording", domain: "posthog.com" },
  { slug: "jira", name: "Jira", description: "Project tracking and agile sprints", domain: "atlassian.com" },
  { slug: "asana", name: "Asana", description: "Tasks and work management", domain: "asana.com" },
  { slug: "trello", name: "Trello", description: "Kanban boards and lists", domain: "trello.com" },
  { slug: "figma", name: "Figma", description: "Design systems and canvas files", domain: "figma.com" },
  { slug: "stripe", name: "Stripe", description: "Payments, customers, and subscriptions", domain: "stripe.com" },
  { slug: "airtable", name: "Airtable", description: "Relational spreadsheets and databases", domain: "airtable.com" },
  { slug: "dropbox", name: "Dropbox", description: "File synchronization and sharing", domain: "dropbox.com" },
  { slug: "x", name: "X", description: "Posts, replies, and mentions", domain: "x.com" },
  { slug: "reddit", name: "Reddit", description: "Subreddits and discussion threads", domain: "reddit.com" },
  { slug: "zapier", name: "Zapier", description: "Automations and multi-app workflows", domain: "zapier.com" },
  { slug: "hubspot", name: "HubSpot", description: "CRM and contact management", domain: "hubspot.com" },
  { slug: "salesforce", name: "Salesforce", description: "Customer relationships and pipeline", domain: "salesforce.com" },
];

/**
 * Returns a list of apps, prioritizing connected integrations followed by
 * popular tools in the marketplace catalog.
 */
export function getAvailableApps(connectedServices?: Record<string, { connected: boolean }>): AppCatalogItem[] {
  const result: AppCatalogItem[] = [];
  const knownSlugs = new Set<string>();

  if (connectedServices) {
    for (const [slug, status] of Object.entries(connectedServices)) {
      if (status?.connected) {
        const lower = slug.toLowerCase();
        const found = POPULAR_APPS.find((a) => a.slug === lower);
        const name = found?.name ?? slug.charAt(0).toUpperCase() + slug.slice(1);
        result.push({
          slug,
          name,
          description: found?.description ?? "Connected Integration",
          domain: found?.domain,
          connected: true,
        });
        knownSlugs.add(lower);
      }
    }
  }

  for (const app of POPULAR_APPS) {
    if (!knownSlugs.has(app.slug.toLowerCase())) {
      result.push(app);
      knownSlugs.add(app.slug.toLowerCase());
    }
  }

  return result;
}
