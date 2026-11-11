import type { Challenge } from './challenge';
import { defaultConfig } from './presets';
import type {
  FaultEvent,
  NodeConfig,
  NodeKind,
  SimEdge,
  SimNode,
  Topology,
} from './types';

/**
 * Real outages, rebuilt from parts the simulator already has.
 *
 * Each one is a scene that plays what happened on a fault schedule, the
 * story in plain words, and a brief judged by the same check as every other
 * challenge. They are not presets and not in CHALLENGES on purpose: neither
 * list moves, so no example's snapshots and no link to one can change.
 *
 * The hard rule is about facts. The story, the date and the source say only
 * what the published postmortem says. Every time and number the simulator
 * shows is its own, and `simNote` says so for each incident, because a model
 * that compresses four hours into thirty seconds must never read as the
 * record of what happened. The briefs' thresholds were measured against the
 * engine; incidents.test.ts pins them.
 */
export interface Incident {
  id: string;
  /** Plain words, no company logo: "S3 goes down in one region". */
  name: string;
  /** The day it happened, as the postmortem dates it. */
  date: string;
  tagline: string;
  source: { title: string; url: string };
  /** What broke, why it spread and how it was fixed, from the postmortem. */
  story: readonly string[];
  /** How the simulator's version differs in time and size from the real one. */
  simNote: string;
  /** The design that plays it, with the faults that recreate it. */
  scene: Topology;
  /** What is happening, by simulated time. Sorted by `atMs`, the first at 0. */
  captions: readonly Caption[];
  brief: Challenge;
}

export interface Caption {
  atMs: number;
  text: string;
}

function node(
  id: string,
  kind: NodeKind,
  label: string,
  x: number,
  y: number,
  overrides: Partial<NodeConfig> = {},
): SimNode {
  return { id, kind, label, x, y, config: { ...defaultConfig(kind), ...overrides } };
}

function edge(from: string, to: string): SimEdge {
  return { id: `${from}->${to}`, from, to, weight: 1 };
}

/* ---------------- S3, 28 February 2017 ---------------- */

const S3_FAULTS: readonly FaultEvent[] = [
  { atMs: 20_000, action: 'inject', nodeId: 's3', kind: 'crash' },
  { atMs: 50_000, action: 'clear', nodeId: 's3' },
];

const S3: Incident = {
  id: 'incident-s3-2017',
  name: 'S3 goes down in one region',
  date: '28 February 2017',
  tagline: 'One mistyped command takes storage offline',
  source: {
    title:
      'Summary of the Amazon S3 Service Disruption in the Northern Virginia (US-EAST-1) Region',
    url: 'https://aws.amazon.com/message/41926/',
  },
  // From the postmortem, in order: "an established playbook", "a small
  // number of servers for one of the S3 subsystems that is used by the S3
  // billing process"; "one of the inputs to the command was entered
  // incorrectly"; the removed servers "supported two other S3 subsystems";
  // "each of these systems to require a full restart" and "S3 was unable to
  // service requests"; "took longer than expected", "not completely
  // restarted ... in our larger regions for many years"; EC2 launches, EBS
  // and Lambda "were also impacted", and the status page could not be
  // updated "because of a dependency the SHD administration console has on
  // Amazon S3"; "remove capacity more slowly", never "below its minimum
  // required capacity level", and the console now runs "across multiple AWS
  // regions".
  story: [
    "An engineer ran a command from a standard playbook to remove a few servers used by S3's billing process.",
    'One input was typed wrong, and far more servers were removed, including ones two core S3 systems depended on.',
    'Both had to restart fully, and S3 in the region could not serve requests until they did.',
    'The restart took longer than expected, partly because these systems had not been fully restarted in the bigger regions for years.',
    'Services built on S3 failed too, and AWS could not update its own status page because its console relied on S3.',
    'AWS changed the tool to remove capacity more slowly and never below a safe minimum, and moved the status console to run across several regions.',
  ],
  simNote: 'The real outage lasted hours. Here S3 is down from 20s to 50s.',
  scene: {
    nodes: [
      node('apps', 'client', 'Apps using S3', 40, 60, { rps: 180, timeoutMs: 2000 }),
      node('status', 'client', 'Status page updates', 40, 320, {
        rps: 20,
        timeoutMs: 2000,
      }),
      node('app', 'service', 'App servers', 300, 60, {
        capacity: 48,
        serviceMs: 10,
        serviceCv: 0.5,
        queueLimit: 128,
      }),
      node('console', 'service', 'Status console', 300, 320, {
        capacity: 8,
        serviceMs: 10,
        serviceCv: 0.5,
        queueLimit: 64,
      }),
      node('s3', 'objectstore', 'S3, one region', 600, 190),
    ],
    edges: [
      edge('apps', 'app'),
      edge('status', 'console'),
      edge('app', 's3'),
      edge('console', 's3'),
    ],
    faults: [...S3_FAULTS],
  },
  captions: [
    {
      atMs: 0,
      text: 'A normal day. The apps and the status console both keep their data in S3.',
    },
    {
      atMs: 20_000,
      text: 'The mistyped command removes the servers S3 needs, and S3 stops answering.',
    },
    {
      atMs: 25_000,
      text: 'Everything that keeps data here fails, the status page included.',
    },
    { atMs: 50_000, text: 'S3 is back. In the real outage, the restart took hours.' },
  ],
  brief: {
    id: 'incident-s3-2017',
    version: 1,
    name: 'Keep the status page up',
    brief:
      'At 20s, S3 in this region goes down for 30 seconds. The apps that keep their data there will fail, and that is not yours to fix. The status page is how everyone finds out what is wrong, so it has to keep working. Lose no more than 15 in 100 status updates, and keep the slowest 1 in 100 within 500ms.',
    presetId: 'incident-s3-2017',
    loadRps: 200,
    faults: S3_FAULTS,
    // A router that switches instantly would hide the cost of switching.
    locks: [{ kind: 'region', field: 'failoverMs' }],
    goals: [
      { metric: 'errorRate', max: 15, route: 'status' },
      { metric: 'p99', max: 500, route: 'status' },
    ],
    hints: [
      'A bigger S3 does not help when S3 is the part that is down.',
      'The status console only knows one place to keep its data. While that place is down, where else could it go?',
      'Look for a component that sends requests to another region when the first one stops answering.',
    ],
    lesson:
      'The status console failed for the same reason everything else did: it depended on the thing that was broken. A second region only helps if something switches to it, and switching takes a few seconds, which is where the lost updates came from. AWS made the same change after the real outage and moved its status console to run across several regions.',
  },
};

/* ---------------- Cloudflare, 2 July 2019 ---------------- */

const CF_FAULTS: readonly FaultEvent[] = [
  {
    atMs: 20_000,
    action: 'inject',
    nodeId: 'edge',
    kind: 'slow',
    opts: { factor: 50 },
  },
  { atMs: 45_000, action: 'clear', nodeId: 'edge' },
];

const EDGE: Partial<NodeConfig> = {
  capacity: 24,
  serviceMs: 4,
  serviceCv: 0.4,
  queueLimit: 256,
};

const CLOUDFLARE: Incident = {
  id: 'incident-cloudflare-2019',
  name: 'A firewall rule takes down the edge',
  date: '2 July 2019',
  tagline: 'A bad rule reaches every server in seconds',
  source: {
    title: 'Details of the Cloudflare outage on July 2, 2019',
    url: 'https://blog.cloudflare.com/details-of-the-cloudflare-outage-on-july-2-2019/',
  },
  // From the postmortem, in order: "simulate" mode where "nothing is
  // blocked", but "the rules actually need to execute"; a regular expression
  // that "backtracked enormously and exhausted CPU" on "every CPU core that
  // handles HTTP/HTTPS traffic", and a rule change "went global in seconds";
  // "a 502 error page when visiting any Cloudflare domain", Dashboard and API
  // unreachable "because they pass through the Cloudflare edge"; "global WAF
  // termination at 14:07", normal "by 14:09", down "for 27 minutes"; a CPU
  // protection "removed by mistake during a refactoring", and "staged
  // rollouts of rules". The 27 minutes is the postmortem's own total; the
  // story does not split it.
  story: [
    'Cloudflare shipped a new firewall rule in a mode meant only to watch traffic, but the rule still ran on every request.',
    'Its regular expression could backtrack enormously, and it used up the processors on every core serving web traffic, worldwide, within seconds.',
    'Visitors to every Cloudflare site got 502 errors, and customers could not reach the Dashboard or API, because those also go through the edge.',
    'Engineers turned the firewall off everywhere, and traffic was back to normal two minutes later, 27 minutes after the outage began.',
    'Cloudflare restored a processor protection a refactor had removed and moved rule changes to staged rollouts.',
  ],
  simNote:
    'The real outage lasted 27 minutes. Here the rule runs from 20s to 45s, and how much slower it makes each request is a number picked for the model.',
  scene: {
    nodes: [
      node('visitors', 'client', 'Visitors to sites', 40, 60, {
        rps: 300,
        timeoutMs: 2000,
      }),
      node('dash', 'client', 'Dashboard and API users', 40, 320, {
        rps: 20,
        timeoutMs: 2000,
      }),
      node('router', 'lb', 'Traffic router', 300, 190),
      node('edge', 'service', 'Edge servers', 560, 190, EDGE),
      node('origin', 'service', 'Origins', 820, 190, {
        capacity: 64,
        serviceMs: 20,
        serviceCv: 0.5,
        queueLimit: 256,
      }),
    ],
    edges: [
      edge('visitors', 'router'),
      edge('dash', 'router'),
      edge('router', 'edge'),
      edge('edge', 'origin'),
    ],
    faults: [...CF_FAULTS],
  },
  captions: [
    {
      atMs: 0,
      text: 'A normal day. Every request, the dashboard included, goes through the edge servers.',
    },
    {
      atMs: 20_000,
      text: 'The new rule reaches every edge server at once. In this model each request now takes 50 times as long.',
    },
    {
      atMs: 25_000,
      text: 'The edge servers are full. Visitors and dashboard users all get errors.',
    },
    {
      atMs: 45_000,
      text: 'The firewall is turned off everywhere. The edge works through the line that built up.',
    },
    { atMs: 55_000, text: 'Back to normal.' },
  ],
  brief: {
    id: 'incident-cloudflare-2019',
    version: 1,
    name: 'Roll it out in stages',
    brief:
      "At 20s, the bad rule lands on the Edge servers and makes each request there 50 times slower until 45s. Cloudflare's fix was to roll out rules in stages, so a bad one reaches only part of the network first. Here the rule lands only on the group called Edge servers, whatever else you add. Lose no more than 2 in 100 requests, and keep the slowest 1 in 100 within 400ms. You can add up to 24 slots.",
    presetId: 'incident-cloudflare-2019',
    loadRps: 320,
    budget: 24,
    faults: CF_FAULTS,
    goals: [
      { metric: 'errorRate', max: 2 },
      { metric: 'p99', max: 400 },
    ],
    hints: [
      'Right now every request goes through the one group the rule lands on.',
      'The traffic router can spread requests over more than one group of servers.',
      'Look at the Edge servers. What if they were only the first stage, and the rest of the edge did not have the rule yet?',
    ],
    lesson:
      'With the edge split into groups, the bad rule only reached the first one, and the traffic router sent requests to the groups that still had room. That is a staged rollout: a change goes to a small part first, so a bad one hurts some requests instead of all of them. The smaller the first stage, the less it can break.',
  },
};

/* ---------------- AWS, 7 December 2021 ---------------- */

const AWS21_FAULTS: readonly FaultEvent[] = [
  {
    atMs: 15_000,
    action: 'inject',
    nodeId: 'devices',
    kind: 'slow',
    opts: { factor: 2 },
  },
  { atMs: 20_000, action: 'clear', nodeId: 'devices' },
];

const AWS21: Incident = {
  id: 'incident-aws-2021',
  name: 'Retries keep a network down',
  date: '7 December 2021',
  tagline: 'Clients that did not back off',
  source: {
    title:
      'Summary of the AWS Service Event in the Northern Virginia (US-EAST-1) Region',
    url: 'https://aws.amazon.com/message/12721/',
  },
  // From the postmortem, in order: "an automated activity to scale capacity"
  // caused "a large surge of connection activity"; it "overwhelmed the
  // networking devices between the internal network" and the main one;
  // "even more connection attempts and retries" and "persistent
  // congestion" from 7:30 AM to "significantly improved by 1:34 PM"; "a
  // latent issue prevented these clients from adequately backing off";
  // "disabled the scaling activities" and a fix to deploy "over the next two
  // weeks". Chosen over Facebook's 2010 outage, whose loop ran through
  // clients deleting cache keys, which the engine has no behaviour for.
  story: [
    "An automated job that adds capacity triggered a surge of connections inside AWS's network.",
    "The devices linking AWS's internal network to its main one were overwhelmed, and calls through them slowed and failed.",
    'Clients answered with even more connection attempts and retries, which kept the devices congested for hours.',
    'A latent bug meant those clients did not back off the way they were designed to.',
    'AWS turned off the scaling job and committed to fixing the clients so they back off properly.',
  ],
  simNote:
    "In the real event the trigger was a surge of connection activity. Here it is the devices slowing to half speed from 15s to 20s, and the numbers are the model's.",
  scene: {
    nodes: [
      node('clients', 'client', 'Clients', 40, 190, { rps: 80, timeoutMs: 3000 }),
      node('callers', 'service', 'Services making calls', 300, 190, {
        capacity: 64,
        serviceMs: 5,
        serviceCv: 0.4,
        queueLimit: 256,
        timeoutMs: 250,
        retries: 2,
      }),
      node('devices', 'service', 'Network devices', 560, 190, {
        capacity: 4,
        serviceMs: 40,
        serviceCv: 0.5,
        queueLimit: 64,
      }),
    ],
    edges: [edge('clients', 'callers'), edge('callers', 'devices')],
    faults: [...AWS21_FAULTS],
  },
  captions: [
    {
      atMs: 0,
      text: 'A normal day. Services call through the network devices, and try again twice when a call takes over 250ms.',
    },
    {
      atMs: 15_000,
      text: 'A surge slows the devices to half speed. Calls start taking too long, and each one is tried again.',
    },
    {
      atMs: 20_000,
      text: 'The devices are back to full speed, but every call now arrives three times.',
    },
    {
      atMs: 30_000,
      text: 'Still down. The trigger is gone, and the retries alone keep the devices full.',
    },
  ],
  brief: {
    id: 'incident-aws-2021',
    version: 1,
    name: 'Make it come back',
    brief:
      "At 15s, the network devices slow to half speed for 5 seconds. Calls will fail while they are slow, and that is fine. Last time, everything stayed down long after the devices recovered. Make sure it comes back: from 30 seconds in, lose no more than 1 in 100 requests, and keep the slowest 1 in 100 within 250ms. You can't add slots, and the lines stay the length they are.",
    presetId: 'incident-aws-2021',
    loadRps: 80,
    warmupS: 30,
    windowS: 40,
    budget: 0,
    faults: AWS21_FAULTS,
    // A short line on the devices turns the extra calls away early. That
    // passes, but it is not the lesson this incident is about.
    locks: [{ kind: 'service', field: 'queueLimit' }],
    goals: [
      { metric: 'errorRate', max: 1 },
      { metric: 'p99', max: 250 },
    ],
    hints: [
      'The devices are back to full speed at 20s. Watch what the services making calls do after that.',
      'Compare how many requests a second the clients send with how many reach the devices.',
      'Look at what the services making calls do when a call takes too long.',
    ],
    lesson:
      'Each slow call was tried three times, so the load on the devices tripled the moment they slowed, and stayed that way after they recovered. Retrying less, or waiting longer than a slow answer takes, lets the devices catch up. The real fix was the same idea: clients that back off properly, so retries ease off instead of piling on.',
  },
};

export const INCIDENTS: readonly Incident[] = [S3, CLOUDFLARE, AWS21];

/** The briefs, for the challenge store and lookup by id. */
export const INCIDENT_BRIEFS: readonly Challenge[] = INCIDENTS.map((i) => i.brief);

export function incidentById(id: string): Incident | undefined {
  return INCIDENTS.find((i) => i.id === id);
}

/** The caption showing at `nowMs`, or null before the first one. */
export function captionAt(incident: Incident, nowMs: number): Caption | null {
  let shown: Caption | null = null;
  for (const c of incident.captions) {
    if (c.atMs <= nowMs) shown = c;
  }
  return shown;
}
