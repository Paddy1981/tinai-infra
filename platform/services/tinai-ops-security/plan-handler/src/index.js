// plan-handler/src/index.js
// Plan definitions with K8s resource quotas for tenant namespaces.

export const PLANS = {
  trial: {
    name: 'Trial',
    quota: {
      cpu: '500m',
      memory: '512Mi',
      storage: '5Gi',
      pods: '5',
    },
  },
  starter: {
    name: 'Starter',
    quota: {
      cpu: '1',
      memory: '1Gi',
      storage: '10Gi',
      pods: '10',
    },
  },
  pro: {
    name: 'Pro',
    quota: {
      cpu: '4',
      memory: '8Gi',
      storage: '50Gi',
      pods: '50',
    },
  },
  enterprise: {
    name: 'Enterprise',
    quota: {
      cpu: '16',
      memory: '32Gi',
      storage: '200Gi',
      pods: '200',
    },
  },
};
