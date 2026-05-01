#cloud-config
package_update: true
packages:
  - curl
  - open-iscsi
  - nfs-common

write_files:
  - path: /etc/sysctl.d/k8s.conf
    content: |
      net.ipv4.ip_forward = 1
      net.bridge.bridge-nf-call-iptables = 1
      fs.inotify.max_user_watches = 524288

runcmd:
  - sysctl --system
  - |
    # Wait for the control-plane API to be reachable
    for i in $(seq 1 30); do
      curl -sk https://${control_plane_ip}:6443 && break
      sleep 10
    done
  - |
    K3S_TOKEN=$(ssh -o StrictHostKeyChecking=no root@${control_plane_ip} 'cat /var/lib/rancher/k3s/server/node-token')
    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=${k3s_version} K3S_URL=https://${control_plane_ip}:6443 K3S_TOKEN=$K3S_TOKEN sh -s - agent
      --node-label "tinai.cloud/region=${cluster_name}"
      --node-label "tinai.cloud/role=worker"
