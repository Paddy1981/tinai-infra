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
      fs.inotify.max_user_instances = 512

runcmd:
  - sysctl --system
  - curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=${k3s_version} sh -s - server
      --cluster-init
      --disable traefik
      --disable servicelb
      --kube-apiserver-arg="audit-log-path=/var/log/kubernetes/audit.log"
      --kube-apiserver-arg="audit-log-maxage=30"
      --kube-apiserver-arg="audit-log-maxbackup=5"
      --kube-apiserver-arg="audit-log-maxsize=100"
      --kube-apiserver-arg="audit-policy-file=/etc/kubernetes/audit-policy.yaml"
      --node-label "tinai.cloud/region=${cluster_name}"
  - mkdir -p /var/log/kubernetes
