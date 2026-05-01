# GPU Node Configuration

This document explains how to prepare Kubernetes nodes to accept tinai.cloud GPU instance pods.

## 1. Label GPU nodes

Two labels are required:

```bash
kubectl label node <node-name> tinai.cloud/gpu=true
kubectl label node <node-name> nvidia.com/gpu.present=true
```

- `tinai.cloud/gpu=true` — used by the NVIDIA device plugin DaemonSet nodeSelector and by the provisioner's pod NodeSelector to target GPU-capable nodes.
- `nvidia.com/gpu.present=true` — used by monitoring and scheduling tooling (e.g. KEDA, Prometheus GPU exporter) to discover GPU nodes.

## 2. Taint GPU nodes

Taint GPU nodes to prevent non-GPU pods from being scheduled onto them, preserving GPU capacity for paying instances:

```bash
kubectl taint node <node-name> nvidia.com/gpu=present:NoSchedule
```

The NVIDIA device plugin DaemonSet and instance pods both carry the matching toleration, so they will still be scheduled correctly.

## 3. Verify the device plugin is advertising GPUs

After labelling and the DaemonSet pod becomes Ready, check that the node exposes GPU capacity:

```bash
kubectl describe node <node-name> | grep -A5 "Capacity:"
# Should show: nvidia.com/gpu: <N>
```

## 4. Node provider

GPU nodes should use a server type that provides NVIDIA GPUs:

- **Hetzner**: Use Hetzner GPU server types (e.g. GX2, GX4) when available in the target region, or attach GPU-capable machines from an external cloud provider via Cluster API or Karpenter.
- **External provider**: Any node joined to the cluster with NVIDIA drivers pre-installed and the NVIDIA container runtime configured will work. Label and taint as above after joining.

## 5. NVIDIA container runtime prerequisite

Each GPU node must have the NVIDIA container runtime installed and configured as the default (or as a RuntimeClass). The device plugin alone is not sufficient — the container runtime is what injects GPU device files into instance pods.

```bash
# On the node (Debian/Ubuntu example):
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=containerd
sudo systemctl restart containerd
```
