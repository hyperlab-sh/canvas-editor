/**
 * Starter templates: the MCP server ships them so an agent can produce
 * something real without any API key, and the editor's empty canvas offers
 * them so a person can too. Each is canonical OpenFlow DSL
 * (src/dsl/grammar.md) that compiles through the same parser the app uses;
 * the test suite compiles all of them.
 */

export interface StarterTemplate {
  name: string;
  title: string;
  family: 'flowchart' | 'architecture' | 'sequence' | 'state' | 'erd';
  summary: string;
  dsl: string;
}

export const C4_STARTER = `%% ofk 1
architecture
title: Shop architecture
model {
 person Customer [desc: Places and tracks orders]
 system Shop [desc: Online shopping] {
  container Web [tech: React, desc: Customer storefront]
  container API [tech: Go, desc: Order processing] {
   component Orders [desc: Validates orders]
  }
  store Database [tech: PostgreSQL, desc: Stores orders]
  Web -> API : submits orders [tech: HTTPS]
  API -> Database : stores orders [tech: SQL]
 }
 external Payments [desc: Processes card payments]
 Customer -> Shop.Web : shops [tech: HTTPS]
 Shop.API -> Payments : charges [tech: HTTPS]
}
views {
 view landscape
 view context of Shop
 view container of Shop
}
flow "Place an order" {
 intro "Customer checks out"
 step Customer -> Shop.Web : confirms cart
 step Shop.Web -> Shop.API : submits order
 step Shop.API -> Shop.Database : saves order
 conclusion "Order confirmed"
}
`;

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {name: 'c4-workspace', title: 'Shop architecture', family: 'architecture', summary: 'One model drawn as a system map, an overview and its services, with a checkout flow.', dsl: C4_STARTER},
  {
    name: 'three-tier-architecture',
    title: 'Three-tier web app on AWS',
    family: 'architecture',
    summary: 'Route 53 and CloudFront at the edge, Fargate services behind a load balancer, RDS, ElastiCache and S3 in the data tier.',
    dsl: `%% ofk 1
architecture right
title: Three-tier web app on AWS

  Users [icon: tabler/users]
  group Edge {
    DNS [icon: aws/networking-content-delivery-route-53, label: "Route 53"]
    CDN [icon: aws/networking-content-delivery-cloudfront, label: "CloudFront + WAF"]
  }
  group "App tier · private subnets" {
    ALB [icon: aws/resource-networking-content-delivery-elastic-load-balancing-application-load-balancer, label: "Load balancer"]
    Web [icon: aws/containers-fargate, label: "Web · Fargate"]
    API [icon: aws/containers-fargate, label: "API · Fargate"]
  }
  group "Data tier" {
    DB [icon: aws/databases-rds, label: "Postgres · RDS"]
    Cache [icon: aws/databases-elasticache, label: "Redis · ElastiCache"]
    Files [icon: aws/storage-simple-storage-service, label: "Uploads · S3"]
  }

  Users -> DNS : app.example.com
  DNS -> CDN
  CDN -> ALB : HTTPS
  ALB -> Web : /
  ALB -> API : /api
  API -> DB : SQL
  API -> Cache : sessions
  API -> Files : signed URLs
`,
  },
  {
    name: 'rag-chatbot',
    title: 'RAG chatbot',
    family: 'architecture',
    summary: 'A chat UI and RAG API answering from a pgvector store with Claude, fed by a nightly ingest of docs.',
    dsl: `%% ofk 1
architecture right
title: RAG chatbot

  Users [icon: tabler/users]
  group "Answer a question" {
    Chat [icon: developer/frontend-nextjs, label: "Chat UI · Next.js"]
    API [icon: developer/languages-python, label: "RAG API · Python"]
    LLM [icon: developer/others-claude-ai, label: "Claude"]
  }
  Vectors [icon: developer/database-postgresql, label: "Vector store · pgvector"]
  group "Ingest, nightly" {
    Docs [icon: tabler/file-text, label: "Docs, Notion, PDFs"]
    Chunker [icon: developer/languages-python, label: "Chunk and embed"]
  }

  Users -> Chat : asks
  Chat -> API : question
  API -> Vectors : similar chunks
  API -> LLM : question + chunks
  Docs -> Chunker
  Chunker -> Vectors : embeddings
`,
  },
  {
    name: 'k8s-microservices',
    title: 'Microservices on Kubernetes',
    family: 'architecture',
    summary: 'NGINX ingress, Go, Node and Python services, Kafka events, Postgres and Redis, and Stripe.',
    dsl: `%% ofk 1
architecture right
title: Microservices on Kubernetes

  Users [icon: tabler/users]
  group "Kubernetes cluster" {
    Ingress [icon: developer/infra-nginx, label: "Ingress · NGINX"]
    Web [icon: developer/frontend-nextjs, label: "web"]
    Orders [icon: developer/others-go, label: "orders"]
    Payments [icon: developer/backend-nodejs, label: "payments"]
    Bus [icon: developer/others-kafka, label: "Kafka"]
    Inventory [icon: developer/languages-python, label: "inventory"]
  }
  group "Managed data" {
    DB [icon: developer/database-postgresql, label: "Postgres"]
    Cache [icon: developer/database-redis, label: "Redis"]
  }
  Stripe [icon: tabler/brand-stripe]

  Users -> Ingress : HTTPS
  Ingress -> Web : /
  Ingress -> Orders : /api/orders
  Web -> Cache : sessions
  Orders -> Payments : gRPC
  Orders -> DB : orders
  Orders --> Bus : order.placed
  Bus --> Inventory : reserve stock
  Inventory -> DB : stock
  Payments -> Stripe : charge
`,
  },
  {
    name: 'event-pipeline',
    title: 'Event pipeline',
    family: 'architecture',
    summary: 'App events and Postgres CDC into Kafka, enriched by Flink into Snowflake, ClickHouse and an S3 archive, with a dead-letter queue.',
    dsl: `%% ofk 1
architecture right
title: Event pipeline

  group Sources {
    App [icon: developer/backend-nodejs, label: "App servers"]
    CDC [icon: developer/database-postgresql, label: "Postgres CDC"]
  }
  Kafka [icon: developer/others-kafka, label: "Kafka topics"]
  group Processing {
    Flink [icon: developer/analytics-flink, label: "Enrich and dedupe · Flink"]
    DLQ [icon: tabler/alert-triangle, red, label: "Dead-letter queue"]
  }
  group Sinks {
    Warehouse [icon: tabler/brand-snowflake, label: "Warehouse · Snowflake"]
    Live [icon: developer/database-clickhouse, label: "Live metrics · ClickHouse"]
    Archive [icon: aws/storage-simple-storage-service, label: "Raw archive · S3"]
  }

  App -> Kafka : events
  CDC -> Kafka : row changes
  Kafka -> Flink
  Kafka -> Archive : raw, kept 1 year
  Flink -> Warehouse : clean events
  Flink -> Live : per-minute counts
  Flink --> DLQ : malformed
`,
  },
  {
    name: 'ci-cd',
    title: 'CI/CD pipeline',
    family: 'flowchart',
    summary: 'Pull request to production: checks, staging, end-to-end tests, a health gate and automatic rollback.',
    dsl: `%% ofk 1
flowchart right
title: CI/CD pipeline

  PR [rounded, blue, label: "Pull request"]
  Checks [label: "Lint, types, unit tests"]
  Green [diamond, amber, label: "All green?"]
  Fix [label: "Fix and push"]
  Staging [label: "Build image, deploy to staging"]
  E2E [diamond, amber, label: "End-to-end tests pass?"]
  Prod [rounded, emerald, label: "Deploy to production"]
  Healthy [diamond, amber, label: "Error rate OK?"]
  Done [ellipse, emerald, label: "Released"]
  Rollback [rounded, red, label: "Automatic rollback"]

  PR -> Checks
  Checks -> Green
  Green -> Fix : no
  Fix -> Checks
  Green -> Staging : yes
  Staging -> E2E
  E2E -> Fix : no
  E2E -> Prod : yes
  Prod -> Healthy
  Healthy -> Done : yes
  Healthy -> Rollback : no
`,
  },
  {
    name: 'oauth-login',
    title: 'Sign in with Google',
    family: 'sequence',
    summary: 'The OAuth 2.0 authorization-code flow with PKCE, between the browser, your app and Google.',
    dsl: `%% ofk 1
sequence
title: Sign in with Google

  participant Browser [icon: tabler/world]
  participant App [icon: tabler/server]
  participant Google [icon: tabler/brand-google]

  Browser -> App : "Sign in with Google"
  App --> Browser : redirect, state + PKCE
  Browser -> Google : authorize
  Google --> Browser : consent screen
  Browser -> Google : approve
  Google --> Browser : redirect with code
  Browser -> App : "/callback?code&state"
  App -> Google : code + PKCE verifier
  Google --> App : ID and access tokens
  alt state matches {
    App --> Browser : session cookie
  } else state differs {
    App --> Browser : "400, start again"
  }
`,
  },
  {
    name: 'request-sequence',
    title: 'Request lifecycle',
    family: 'sequence',
    summary: 'An API request through the gateway, token check and order service, with in-stock and out-of-stock replies.',
    dsl: `%% ofk 1
sequence
title: Request lifecycle

  participant Browser
  participant Gateway
  participant Auth
  participant Orders
  participant Database [db]

  autonumber
  Browser -> Gateway : POST /orders with JWT
  Gateway -> Auth : verify token
  Auth --> Gateway : user 42, scope orders:write
  Gateway -> Orders : create order
  activate Orders
  Orders -> Database : reserve stock + insert order
  alt in stock {
    Database --> Orders : order 1081
    Orders --> Gateway : "201 {orderId}"
  } else out of stock {
    Database --> Orders : constraint failed
    Orders --> Gateway : "409 {reason}"
  }
  deactivate Orders
  Gateway --> Browser : response
`,
  },
  {
    name: 'saas-erd',
    title: 'SaaS data model',
    family: 'erd',
    summary: 'Organizations, users and memberships, projects, and Stripe subscriptions with invoices.',
    dsl: `%% ofk 1
erd right
title: SaaS data model

  organizations [blue] {
    id uuid pk
    name text
    plan text
    created_at timestamptz
  }
  users [blue] {
    id uuid pk
    email text unique
    name text
  }
  memberships {
    org_id uuid pk fk
    user_id uuid pk fk
    role text
  }
  projects {
    id uuid pk
    org_id uuid fk
    name text
  }
  subscriptions [violet] {
    id uuid pk
    org_id uuid fk
    stripe_id text unique
    status text
    renews_at timestamptz
  }
  invoices [violet] {
    id uuid pk
    sub_id uuid fk
    amount_cents int
    paid_at timestamptz null
  }

  organizations ||--o{ memberships : has
  users ||--o{ memberships : joins
  organizations ||--o{ projects : owns
  organizations ||--o| subscriptions : pays with
  subscriptions ||--o{ invoices : bills
`,
  },
  {
    name: 'order-state',
    title: 'Order state machine',
    family: 'state',
    summary: 'Cart to delivery, with declined payments, cancellations and refunds.',
    dsl: `%% ofk 1
state right
title: Order state machine

  [*] -> Cart
  Cart -> Checkout : check out
  Checkout -> Cart : edit cart
  Checkout -> Paid : payment succeeds
  Checkout -> Failed : card declined
  Failed -> Checkout : retry
  Failed -> Cancelled : after 24 h
  Paid -> Cancelled : customer cancels
  Paid -> Shipped : packed and collected
  Shipped -> Delivered : delivered
  Delivered -> Refunded : returned
  Delivered -> [*]
  Refunded -> [*]
  Cancelled -> [*]
`,
  },
  {
    name: 'auth-flow',
    title: 'User authentication',
    family: 'flowchart',
    summary: 'SSO or password, a lockout after failed tries, and an optional two-factor step.',
    dsl: `%% ofk 1
flowchart down
title: User authentication

  Start [ellipse, emerald]
  Login [rounded, blue]
  SSO [rounded, blue, label: "Google or GitHub"]
  Valid [diamond, amber, label: "Valid?"]
  Tries [diamond, amber, label: "5 failed tries?"]
  Locked [ellipse, red, label: "Locked for 15 minutes"]
  MFA [diamond, amber, label: "Two-factor on?"]
  Code [rounded, violet, label: "Enter 6-digit code"]
  Session [rounded, blue, label: "Create session"]
  Dashboard [ellipse, emerald]

  Start -> Login : email and password
  Start -> SSO : SSO
  Login -> Valid
  Valid -> Tries : no
  Tries -> Login : no, try again
  Tries -> Locked : yes
  Valid -> MFA : yes
  MFA -> Code : yes
  MFA -> Session : no
  Code -> Session : code valid
  SSO -> Session
  Session -> Dashboard
`,
  },
  {
    name: 'simple-process',
    title: 'Purchase approval',
    family: 'flowchart',
    summary: 'A purchase request routed to a manager or finance by amount, with a revise loop.',
    dsl: `%% ofk 1
flowchart right
title: Purchase approval

  Request [rounded, emerald, label: "Request submitted"]
  Budget [diamond, amber, label: "Over $5,000?"]
  Manager [label: "Manager reviews"]
  Finance [label: "Finance reviews"]
  Decision [diamond, amber, label: "Approved?"]
  Order [rounded, emerald, label: "Purchase order sent"]
  Revise [label: "Requester revises"]

  Request -> Budget
  Budget -> Manager : no
  Budget -> Finance : yes
  Manager -> Decision
  Finance -> Decision
  Decision -> Order : yes
  Decision -> Revise : no
  Revise -> Budget
`,
  },
];

export function findStarterTemplate(name: string): StarterTemplate | undefined {
  return STARTER_TEMPLATES.find((template) => template.name === name);
}
