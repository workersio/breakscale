import type { Vendor } from './types';

/* ------------------------------------------------------------------ *
 * AWS product names and published instance specs.
 *
 * WHAT THIS FILE IS.
 *
 * Published spec data, and nothing else. Every vCPU count, memory figure,
 * network string and price below was read from an AWS page or from the AWS
 * Price List API, and carries the URL it came from. Prices carry the date
 * they were read, because they change and a stale number that does not say
 * so is worse than no number.
 *
 * WHAT THIS FILE IS NOT.
 *
 * It is not the mapping from these specs to simulator behaviour. Nothing
 * here says how a vCPU count becomes `capacity` or `serviceMs`; that is a
 * model, it lives in `derive.ts`, and it is labelled as derived wherever it
 * is shown. See the header of `types.ts` for why the two are kept apart.
 *
 * ON MISSING FIELDS.
 *
 * Several fields a reader might expect are absent, deliberately. AGENTS.md
 * says a component with no meaningful value shows nothing rather than a
 * plausible-looking number, and that applies here first. The three gaps
 * worth knowing about:
 *
 * 1. `maxIops` is absent from every EC2 and RDS size. AWS does not publish
 *    max IOPS per instance class. It publishes it per EBS VOLUME TYPE and
 *    per storage size, and the instance class applies a separate ceiling on
 *    top. See RDS_STORAGE_IOPS below for the figures that ARE published,
 *    kept out of the size records because they do not belong to a size.
 *
 * 2. `maxConnections` is absent from every RDS size. AWS publishes a
 *    FORMULA, not a number: PostgreSQL is
 *    `LEAST({DBInstanceClassMemory/9531392}, 5000)`. `DBInstanceClassMemory`
 *    is not the instance's GiB figure, it is that minus an unpublished
 *    reservation for the OS and RDS processes, and the docs show the
 *    difference is real: for 8 GiB, the naive arithmetic gives 683 while
 *    the actual value is about 630. Computing it here would produce exactly
 *    the confident wrong number this project forbids.
 *
 * 3. `maxConnections` IS present on the ElastiCache sizes, because there
 *    AWS publishes a literal per-node-type default for `maxclients`, and it
 *    genuinely differs between node types.
 *
 * ON "UP TO".
 *
 * The `network` strings are copied verbatim and most of them begin "Up to".
 * That wording is load-bearing: it is a burst ceiling, not a sustained
 * rate. Smaller sizes hold a much lower baseline and burst above it only on
 * credit. AWS publishes the baseline separately in its network specs table
 * (m6i.large, for instance, is "0.781 / 12.5" baseline/burst Gbps), so a
 * reader who treats the "Up to 12.5" as a steady figure is off by about
 * sixteen times. The strings are kept as text so that ceiling cannot be
 * silently rounded into a promise.
 * ------------------------------------------------------------------ */

/** Every price in this file is on-demand, in this region. */
const REGION = 'us-east-1';

/**
 * The date the prices were read.
 *
 * All of them come from one pull of the AWS Price List API, so one date
 * covers the file. The API's own publication stamps were 2026-08-27 for
 * EC2, 2026-08-28 for RDS and 2026-08-21 for ElastiCache.
 */
const PRICED_ON = '2026-08-28';

/**
 * The AWS Price List API, which is where the prices and the vCPU, memory
 * and network strings for every size below came from.
 *
 * Preferred over the pricing pages because those render their tables in
 * JavaScript, so they cannot be quoted from directly, and because this is
 * the same data the console bills from. The `<service>` segment is
 * AmazonEC2, AmazonRDS or AmazonElastiCache.
 */
const PRICE_LIST_API =
  'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.json';
const PRICE_LIST_API_RDS =
  'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/us-east-1/index.json';
const PRICE_LIST_API_ELASTICACHE =
  'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/current/us-east-1/index.json';

/**
 * ElastiCache `maxclients` defaults, which vary by node type.
 *
 * Read from the engine parameter reference. This is the one per-size
 * connection ceiling AWS states as a literal number rather than a formula,
 * which is why the cache sizes below carry `maxConnections` and the RDS
 * sizes do not. It is documented as not modifiable.
 */
const ELASTICACHE_PARAMS =
  'https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/ParameterGroups.Engine.html';

/**
 * Published IOPS ceilings for RDS storage.
 *
 * Kept here rather than on any size record because IOPS is a property of
 * the STORAGE VOLUME and the engine, not of the instance class. The same
 * db.r6g.large gets 3,000 IOPS on a small gp3 volume or 256,000 on io2
 * Block Express. Putting a number on the size would attach it to the wrong
 * thing.
 *
 * Figures are for Db2, MariaDB, MySQL and PostgreSQL. Note the docs also
 * warn that the instance class applies its own ceiling on top: four 64,000
 * IOPS volumes on an instance capped at 40,000 deliver 40,000.
 */
export const RDS_STORAGE_IOPS = {
  /** Baseline on gp3 below the striping threshold, 20-399 GiB. */
  gp3BaselineIops: 3000,
  /** Baseline on gp3 at or above the striping threshold, 400+ GiB. */
  gp3StripedBaselineIops: 12000,
  /** Top of the provisionable gp3 range. */
  gp3MaxProvisionedIops: 64000,
  /** Top of the provisionable io2 Block Express range. */
  io2MaxProvisionedIops: 256000,
  source: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html',
} as const;

/**
 * The formula AWS publishes for the RDS connection limit, as text.
 *
 * Deliberately a string and not a computed number, for the reason in the
 * file header: the memory term is not the published GiB figure.
 */
export const RDS_MAX_CONNECTIONS_FORMULA = {
  postgresql: 'LEAST({DBInstanceClassMemory/9531392}, 5000)',
  mysql: '{DBInstanceClassMemory/12582880}',
  note: 'DBInstanceClassMemory is the instance memory minus an unpublished reservation for the OS and RDS processes, so this cannot be evaluated from the GiB column. AWS gives a worked example where the naive result is 683 and the real value is about 630.',
  source: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html',
} as const;

export const AWS: Vendor = {
  id: 'aws',
  label: 'AWS',
  region: REGION,
  kinds: {
    client: {
      product: 'Client',
      note: 'Not an AWS product. Traffic originates outside the account, so there is nothing to name here.',
    },

    lb: {
      product: 'Elastic Load Balancing (Application Load Balancer)',
      note: 'ELB is three products. ALB is the HTTP one and the one a web system design means; NLB is layer 4, and the Classic balancer is previous generation.',
    },

    service: {
      product: 'Amazon EC2',
      note: 'The instance a student pictures when they say "a server". ECS, EKS and App Runner all schedule onto the same hardware, so the sizes below are what any of them ultimately buy.',
      sizes: [
        {
          name: 't3.micro',
          vcpu: 2,
          memory: 1,
          memoryUnit: 'GiB',
          // Burstable. The baseline is a fraction of this and the instance
          // spends credit to reach it, so the wording matters more here
          // than on the fixed-performance classes below.
          network: 'Up to 5 Gigabit',
          pricePerHour: 0.0104,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API,
        },
        {
          name: 't3.medium',
          vcpu: 2,
          memory: 4,
          memoryUnit: 'GiB',
          network: 'Up to 5 Gigabit',
          pricePerHour: 0.0416,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API,
        },
        {
          name: 'm6i.large',
          vcpu: 2,
          memory: 8,
          memoryUnit: 'GiB',
          network: 'Up to 12500 Megabit',
          pricePerHour: 0.096,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API,
        },
        {
          name: 'm6i.xlarge',
          vcpu: 4,
          memory: 16,
          memoryUnit: 'GiB',
          network: 'Up to 12500 Megabit',
          pricePerHour: 0.192,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API,
        },
        {
          name: 'm6i.2xlarge',
          vcpu: 8,
          memory: 32,
          memoryUnit: 'GiB',
          network: 'Up to 12500 Megabit',
          pricePerHour: 0.384,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API,
        },
      ],
    },

    db: {
      product: 'Amazon RDS',
      note: 'RDS runs the engine a student already knows, usually PostgreSQL or MySQL. Aurora is the AWS-built alternative and DynamoDB is not relational at all, so neither is the honest default for a box labelled "database". Prices below are PostgreSQL, Single-AZ; Multi-AZ costs more.',
      sizes: [
        {
          name: 'db.t4g.micro',
          vcpu: 2,
          memory: 1,
          memoryUnit: 'GiB',
          network: 'Up to 5 Gigabit',
          pricePerHour: 0.016,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API_RDS,
        },
        {
          name: 'db.t3.medium',
          vcpu: 2,
          memory: 4,
          memoryUnit: 'GiB',
          // AWS publishes a WORD here, not a rate. Left as written rather
          // than guessing what "Moderate" is in Gbps.
          network: 'Low to Moderate',
          pricePerHour: 0.072,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API_RDS,
        },
        {
          name: 'db.m6i.large',
          vcpu: 2,
          memory: 8,
          memoryUnit: 'GiB',
          network: 'Up to 12.5 Gbps',
          pricePerHour: 0.178,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API_RDS,
        },
        {
          name: 'db.r6g.large',
          vcpu: 2,
          memory: 16,
          memoryUnit: 'GiB',
          network: 'Up to 10 Gigabit',
          pricePerHour: 0.225,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API_RDS,
        },
        {
          name: 'db.r6g.xlarge',
          vcpu: 4,
          memory: 32,
          memoryUnit: 'GiB',
          network: 'Up to 10 Gigabit',
          pricePerHour: 0.45,
          pricedOn: PRICED_ON,
          source: PRICE_LIST_API_RDS,
        },
      ],
    },

    cache: {
      product: 'Amazon ElastiCache',
      note: "Prices below are the Redis OSS node-hour rate. Valkey is cheaper and Memcached matches Redis, so the engine choice moves the number. The memory figures are AWS's own and are not round: a cache.r6g.large is published as 13.07 GiB, being what is left for data after the node reserves its own.",
      sizes: [
        {
          name: 'cache.t4g.micro',
          vcpu: 2,
          memory: 0.5,
          memoryUnit: 'GiB',
          network: 'Up to 5 Gigabit',
          // The one node type in this list with a lower ceiling than the
          // 65000 that every other type defaults to.
          maxConnections: 20000,
          pricePerHour: 0.016,
          pricedOn: PRICED_ON,
          source: `${PRICE_LIST_API_ELASTICACHE} (specs and price); ${ELASTICACHE_PARAMS} (maxclients)`,
        },
        {
          name: 'cache.t4g.medium',
          vcpu: 2,
          memory: 3.09,
          memoryUnit: 'GiB',
          network: 'Up to 5 Gigabit',
          maxConnections: 65000,
          pricePerHour: 0.065,
          pricedOn: PRICED_ON,
          source: `${PRICE_LIST_API_ELASTICACHE} (specs and price); ${ELASTICACHE_PARAMS} (maxclients)`,
        },
        {
          name: 'cache.m7g.large',
          vcpu: 2,
          memory: 6.38,
          memoryUnit: 'GiB',
          network: 'Up to 12.5 Gigabit',
          maxConnections: 65000,
          pricePerHour: 0.158,
          pricedOn: PRICED_ON,
          source: `${PRICE_LIST_API_ELASTICACHE} (specs and price); ${ELASTICACHE_PARAMS} (maxclients)`,
        },
        {
          name: 'cache.r6g.large',
          vcpu: 2,
          memory: 13.07,
          memoryUnit: 'GiB',
          network: 'Up to 10 Gigabit',
          maxConnections: 65000,
          pricePerHour: 0.206,
          pricedOn: PRICED_ON,
          source: `${PRICE_LIST_API_ELASTICACHE} (specs and price); ${ELASTICACHE_PARAMS} (maxclients)`,
        },
        {
          name: 'cache.r6g.xlarge',
          vcpu: 4,
          memory: 26.32,
          memoryUnit: 'GiB',
          network: 'Up to 10 Gigabit',
          maxConnections: 65000,
          pricePerHour: 0.411,
          pricedOn: PRICED_ON,
          source: `${PRICE_LIST_API_ELASTICACHE} (specs and price); ${ELASTICACHE_PARAMS} (maxclients)`,
        },
      ],
    },

    queue: {
      product: 'Amazon SQS',
      note: 'A queue one consumer drains. Kafka-style fan-out to many independent readers is a different shape and belongs on the stream broker.',
    },

    worker: {
      product: 'Amazon EC2',
      note: 'A worker is a server that reads from a queue instead of from a socket, so it is the same EC2 hardware as a service. Sizes are shared with `service` rather than repeated, because repeating them would let the two drift.',
      sizesFrom: 'service',
    },

    cdn: {
      product: 'Amazon CloudFront',
    },

    objectstore: {
      product: 'Amazon S3',
    },

    searchindex: {
      product: 'Amazon OpenSearch Service',
    },

    timeseriesdb: {
      product: 'Amazon Timestream for InfluxDB',
      note: 'Timestream now covers time series through managed InfluxDB, which is also the engine a student is most likely to have met.',
    },

    graphdb: {
      product: 'Amazon Neptune',
    },

    coldstorage: {
      product: 'Amazon S3 Glacier',
      note: 'A storage class of S3 rather than a separate service, chosen because the retrieval delay is the thing being taught.',
    },

    vectordb: {
      product: 'Amazon OpenSearch Serverless (vector search collection)',
      note: 'AWS sells no standalone vector database. The nearest purpose-built thing is a vector search collection on OpenSearch Serverless, which is also what Bedrock knowledge bases default to.',
    },

    streambroker: {
      product: 'Amazon Kinesis Data Streams',
      note: 'Kinesis is the AWS-native one and shows the shard model plainly. Amazon MSK is the choice if the lesson depends on Kafka itself rather than on partitioned streaming.',
    },

    pubsub: {
      product: 'Amazon SNS',
      note: 'Fan-out to subscribers, as against SQS, which is one queue drained by one consumer group. The pair is usually taught together.',
    },

    websocket: {
      product: 'Amazon API Gateway (WebSocket API)',
      note: 'A distinct API type from the REST and HTTP ones, because it holds the connection open and bills per connection-minute.',
    },

    apigateway: {
      product: 'Amazon API Gateway',
      note: 'The HTTP API is the cheaper and simpler of the two request/response types; the REST API is the one with the fuller feature set.',
    },

    lambda: {
      product: 'AWS Lambda',
    },

    cron: {
      product: 'Amazon EventBridge Scheduler',
      note: 'The current scheduling product. EventBridge rules on a schedule expression still work and are what older material shows.',
    },

    ratelimiter: {
      product: 'AWS WAF (rate-based rules)',
      note: 'Two different products limit rate. WAF drops abusive traffic at the edge, which is what a rate limiter in a diagram usually means; API Gateway usage plans throttle a known caller to a quota.',
    },

    replica: {
      product: 'Amazon RDS read replica',
      note: 'Not a separate product. A replica is an RDS instance sized on its own, so the `db` sizes apply.',
    },

    shard: {
      product: 'Amazon RDS',
      note: 'AWS sells no sharding product for RDS. A shard is one more independent RDS instance and the application decides what goes where, which is the point worth teaching.',
    },

    edgecompute: {
      product: 'Amazon CloudFront Functions',
      note: 'Two options run at the edge. CloudFront Functions is the light one, for header and URL work at the point of presence; Lambda@Edge runs longer and costs more.',
    },

    transcoder: {
      product: 'AWS Elemental MediaConvert',
      note: 'The file-based transcoder, which is the batch "convert this upload" job. MediaLive is the live-stream counterpart. Elastic Transcoder is the previous generation.',
    },
  },
};
