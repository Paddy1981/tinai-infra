#!/usr/bin/env node
// tinai.js — Tinai infrastructure-from-code CLI
// Commands: analyse | generate | deploy
// Reads tinai.json from cwd, validates against JSON Schema, generates k8s YAMLs,
// and optionally applies them via kubectl.

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ── dependency: ajv (JSON Schema validator) ────────────────────────────────────
let Ajv;
try {
  Ajv = require('ajv');
} catch {
  console.error('ERROR: ajv not installed. Run: npm install (inside cli/)');
  process.exit(1);
}

// ── constants ─────────────────────────────────────────────────────────────────
const TINAI_JSON = path.join(process.cwd(), 'tinai.json');
const MANIFESTS_DIR = path.join(process.cwd(), '.tinai', 'manifests');
const SCHEMA_PATH = path.join(__dirname, 'schema', 'tinai-schema.json');
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 300000; // 5 min

// ── helpers ───────────────────────────────────────────────────────────────────

function readSpec() {
  if (!fs.existsSync(TINAI_JSON)) {
    console.error(`ERROR: tinai.json not found in ${process.cwd()}`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(TINAI_JSON, 'utf8'));
  } catch (e) {
    console.error(`ERROR: Failed to parse tinai.json — ${e.message}`);
    process.exit(1);
  }
}

function validateSpec(spec) {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  if (!validate(spec)) {
    console.error('tinai.json validation errors:');
    for (const err of validate.errors) {
      console.error(`  ${err.instancePath || '(root)'} — ${err.message}`);
    }
    process.exit(1);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeManifest(name, content) {
  const filePath = path.join(MANIFESTS_DIR, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function indent(str, spaces) {
  const pad = ' '.repeat(spaces);
  return str.split('\n').map(l => pad + l).join('\n');
}

// ── YAML generators ───────────────────────────────────────────────────────────

function generateDeployment(svc) {
  const replicas = svc.replicas ?? 1;
  const memory = svc.memory ?? '256Mi';
  const cpu = svc.cpu ?? '100m';

  const envBlock = Object.entries(svc.env || {})
    .map(([k, v]) => `        - name: ${k}\n          value: "${v}"`)
    .join('\n');

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${svc.name}
  labels:
    app.kubernetes.io/name: ${svc.name}
    app.kubernetes.io/managed-by: tinai-cli
spec:
  replicas: ${replicas}
  selector:
    matchLabels:
      app: ${svc.name}
  template:
    metadata:
      labels:
        app: ${svc.name}
        app.kubernetes.io/name: ${svc.name}
    spec:
      containers:
        - name: ${svc.name}
          image: ${svc.image}
          ports:
            - containerPort: ${svc.port}
              protocol: TCP
${envBlock ? `          env:\n${envBlock}` : ''}
          resources:
            requests:
              memory: "${memory}"
              cpu: "${cpu}"
            limits:
              memory: "${memory}"
              cpu: "${cpu}"
`;
}

function generateService(svc) {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${svc.name}
  labels:
    app.kubernetes.io/name: ${svc.name}
    app.kubernetes.io/managed-by: tinai-cli
spec:
  selector:
    app: ${svc.name}
  ports:
    - port: ${svc.port}
      targetPort: ${svc.port}
      protocol: TCP
  type: ClusterIP
`;
}

function generatePVC(vol) {
  const accessMode = vol.accessMode ?? 'ReadWriteOnce';
  const scLine = vol.storageClass
    ? `  storageClassName: ${vol.storageClass}`
    : '  # storageClassName: (cluster default)';

  return `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${vol.name}
  labels:
    app.kubernetes.io/managed-by: tinai-cli
spec:
  accessModes:
    - ${accessMode}
${scLine}
  resources:
    requests:
      storage: ${vol.size}
`;
}

function generateCNPGCluster(db) {
  const version = db.version ?? '16';
  const instances = db.instances ?? 1;
  const storage = db.storage ?? '1Gi';

  return `apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: ${db.name}
  labels:
    app.kubernetes.io/managed-by: tinai-cli
spec:
  instances: ${instances}
  imageName: ghcr.io/cloudnative-pg/postgresql:${version}
  storage:
    size: ${storage}
  postgresql:
    parameters:
      max_connections: "200"
  monitoring:
    enablePodMonitor: true
`;
}

function generateIngress(domain, spec) {
  const tls = domain.tls !== false;
  const tlsSecret = domain.tlsSecret ?? `${domain.service}-tls`;
  const pathPrefix = domain.pathPrefix ?? '/';

  // Find the port for the referenced service
  const svc = (spec.services || []).find(s => s.name === domain.service);
  if (!svc) {
    console.warn(`WARN: domain references unknown service "${domain.service}" — skipping ingress`);
    return null;
  }

  const tlsSection = tls
    ? `  tls:
    - hosts:
        - ${domain.host}
      secretName: ${tlsSecret}
`
    : '';

  const annotations = tls
    ? `  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
`
    : '';

  return `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${domain.service}-ingress
  labels:
    app.kubernetes.io/name: ${domain.service}
    app.kubernetes.io/managed-by: tinai-cli
${annotations}spec:
${tlsSection}  rules:
    - host: ${domain.host}
      http:
        paths:
          - path: ${pathPrefix}
            pathType: Prefix
            backend:
              service:
                name: ${domain.service}
                port:
                  number: ${svc.port}
`;
}

// ── command: analyse ──────────────────────────────────────────────────────────

function cmdAnalyse() {
  console.log(`Reading ${TINAI_JSON} …`);
  const spec = readSpec();
  validateSpec(spec);

  const services = spec.services || [];
  const volumes = spec.volumes || [];
  const databases = spec.databases || [];
  const domains = spec.domains || [];

  console.log('\n✓ tinai.json is valid\n');
  console.log('Summary');
  console.log('───────────────────────────────────────');
  console.log(`Services  : ${services.length}`);
  for (const s of services) {
    console.log(`  • ${s.name}  image=${s.image}  port=${s.port}  replicas=${s.replicas ?? 1}`);
  }
  console.log(`Volumes   : ${volumes.length}`);
  for (const v of volumes) {
    console.log(`  • ${v.name}  size=${v.size}`);
  }
  console.log(`Databases : ${databases.length}`);
  for (const d of databases) {
    console.log(`  • ${d.name}  pg${d.version ?? 16}  instances=${d.instances ?? 1}`);
  }
  console.log(`Domains   : ${domains.length}`);
  for (const d of domains) {
    console.log(`  • ${d.host}  → ${d.service}`);
  }
  console.log('───────────────────────────────────────');
  return spec;
}

// ── command: generate ─────────────────────────────────────────────────────────

function cmdGenerate(spec) {
  if (!spec) {
    spec = cmdAnalyse();
  }

  ensureDir(MANIFESTS_DIR);
  const written = [];

  // Services → Deployment + Service
  for (const svc of spec.services || []) {
    const depYaml = generateDeployment(svc);
    const svcYaml = generateService(svc);
    written.push(writeManifest(`${svc.name}-deployment.yaml`, depYaml));
    written.push(writeManifest(`${svc.name}-service.yaml`, svcYaml));
  }

  // Volumes → PVC
  for (const vol of spec.volumes || []) {
    const pvcYaml = generatePVC(vol);
    written.push(writeManifest(`${vol.name}-pvc.yaml`, pvcYaml));
  }

  // Databases → CNPG Cluster
  for (const db of spec.databases || []) {
    const clusterYaml = generateCNPGCluster(db);
    written.push(writeManifest(`${db.name}-cnpg.yaml`, clusterYaml));
  }

  // Domains → Ingress
  for (const domain of spec.domains || []) {
    const ingressYaml = generateIngress(domain, spec);
    if (ingressYaml) {
      written.push(writeManifest(`${domain.service}-ingress.yaml`, ingressYaml));
    }
  }

  console.log(`\nGenerated ${written.length} manifest(s) in ${MANIFESTS_DIR}`);
  for (const f of written) {
    console.log(`  ${path.relative(process.cwd(), f)}`);
  }
  return written;
}

// ── command: deploy ───────────────────────────────────────────────────────────

function requireKubectl() {
  const result = spawnSync('kubectl', ['version', '--client', '--output=json'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    console.error('ERROR: kubectl not found on PATH. Install kubectl and ensure KUBECONFIG is set.');
    process.exit(1);
  }
}

function kubectlApply() {
  console.log(`\nApplying manifests from ${MANIFESTS_DIR} …`);
  const result = spawnSync(
    'kubectl',
    ['apply', '-f', MANIFESTS_DIR],
    { encoding: 'utf8', stdio: 'inherit' }
  );
  if (result.status !== 0) {
    console.error('ERROR: kubectl apply failed');
    process.exit(1);
  }
}

function pollPodsReady(spec) {
  const deploymentNames = (spec.services || []).map(s => s.name);
  if (deploymentNames.length === 0) return;

  console.log('\nWaiting for pods to be Running …');
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    let allReady = true;

    for (const name of deploymentNames) {
      const result = spawnSync(
        'kubectl',
        ['rollout', 'status', `deployment/${name}`, '--timeout=5s'],
        { encoding: 'utf8' }
      );
      if (result.status !== 0) {
        allReady = false;
        process.stdout.write(`  ${name}: not ready yet …\r`);
        break;
      }
    }

    if (allReady) {
      console.log('\nAll deployments are Ready.');
      return;
    }

    // Sleep synchronously between polls
    const until = Date.now() + POLL_INTERVAL_MS;
    while (Date.now() < until) { /* busy-wait — acceptable in a short-lived CLI */ }
  }

  console.warn('\nWARN: Timed out waiting for pods. Check with: kubectl get pods');
}

function printAppURLs(spec) {
  const domains = spec.domains || [];
  if (domains.length === 0) return;

  console.log('\nApp URLs:');
  for (const d of domains) {
    const scheme = d.tls !== false ? 'https' : 'http';
    console.log(`  ${scheme}://${d.host}${d.pathPrefix ?? '/'}`);
  }
}

function cmdDeploy() {
  requireKubectl();

  // 1. Analyse
  const spec = cmdAnalyse();

  // 2. Generate
  cmdGenerate(spec);

  // 3. Apply
  kubectlApply();

  // 4. Poll
  pollPodsReady(spec);

  // 5. Print URLs
  printAppURLs(spec);

  console.log('\nDeploy complete.');
}

// ── entry point ───────────────────────────────────────────────────────────────

const [, , command, ...args] = process.argv;

switch (command) {
  case 'analyse':
  case 'analyze':
    cmdAnalyse();
    break;

  case 'generate':
    cmdGenerate();
    break;

  case 'deploy':
    cmdDeploy();
    break;

  default:
    console.log(`tinai CLI — infrastructure-from-code for the Tinai platform

Usage:
  tinai analyse   Validate tinai.json and print a project summary
  tinai generate  Generate Kubernetes manifests into .tinai/manifests/
  tinai deploy    analyse → generate → kubectl apply → poll → print URLs

tinai.json must exist in the current working directory.
Schema: ${SCHEMA_PATH}
`);
    process.exit(command ? 1 : 0);
}
