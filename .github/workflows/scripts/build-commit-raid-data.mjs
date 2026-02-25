import fs from "node:fs/promises";
import path from "node:path";

const token = process.env.GITHUB_TOKEN;
const username = process.env.TARGET_USERNAME || "jaumnp";

if (!token) {
  console.error("GITHUB_TOKEN não encontrado.");
  process.exit(1);
}

const query = `
query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            contributionCount
            contributionLevel
            date
            weekday
          }
        }
      }
    }
  }
}
`;

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function laneFromDate(date) {
  // retorna valor entre -1 e 1 em "faixas"
  const h = hashString(date);
  const lanes = [-1, -0.5, 0, 0.5, 1];
  return lanes[h % lanes.length];
}

function buildEnemy(day) {
  const c = day.contributionCount;
  const level =
    c >= 12 ? "VERY_HIGH" :
    c >= 8 ? "HIGH" :
    c >= 4 ? "MEDIUM" : "LOW";

  const kind =
    c >= 14 ? "boss" :
    c >= 8 ? "elite" : "grunt";

  const hp = 24 + c * (kind === "boss" ? 14 : kind === "elite" ? 12 : 9);
  const speed = Math.min(1.2, 0.42 + c * 0.035);

  return {
    date: day.date,
    count: c,
    level,
    lane: laneFromDate(day.date),
    hp,
    speed,
    kind,
    label: `${c} commit${c > 1 ? "s" : ""}`
  };
}

async function fetchContributionCalendar() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "commit-raid-generator"
    },
    body: JSON.stringify({
      query,
      variables: { login: username }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub GraphQL ${res.status}: ${text}`);
  }

  const json = await res.json();

  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  const calendar = json?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new Error("Resposta sem contributionCalendar");
  return calendar;
}

function flattenDays(calendar) {
  return calendar.weeks.flatMap(w => w.contributionDays);
}

function keepRecentDays(days, maxDays = 140) {
  // pega os últimos N dias para o jogo ficar dinâmico e não longo demais
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.slice(-maxDays);
}

async function main() {
  const calendar = await fetchContributionCalendar();
  const allDays = flattenDays(calendar);
  const recentDays = keepRecentDays(allDays, 140);

  const enemies = recentDays
    .filter(d => d.contributionCount > 0)
    .map(buildEnemy);

  const payload = {
    generatedAt: new Date().toISOString(),
    username,
    totalContributions: calendar.totalContributions,
    source: "github-graphql-contribution-calendar",
    windowDays: recentDays.length,
    enemies
  };

  const outDir = path.join(process.cwd(), "docs", "data");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(
    path.join(outDir, "commit-enemies.json"),
    JSON.stringify(payload, null, 2),
    "utf8"
  );

  console.log(`Gerado docs/data/commit-enemies.json com ${enemies.length} inimigos.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});