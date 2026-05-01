# ArgoCD Bootstrap

## First-time setup

1. Install ArgoCD:
   kubectl create namespace argocd
   kubectl apply -k argocd/install/

2. Create the AppProject and root Application:
   kubectl apply -f argocd/project.yaml -n argocd
   kubectl apply -f argocd/app-of-apps.yaml -n argocd

3. ArgoCD will self-manage from this point. All subsequent changes
   are made by pushing to main — ArgoCD syncs within 3 minutes.

## Accessing the UI
   kubectl port-forward svc/argocd-server -n argocd 8080:443

## Getting the initial admin password
   kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath="{.data.password}" | base64 -d
