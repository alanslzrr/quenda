# A stand-in for a cloud VM: Ubuntu 24.04 booted by systemd, with cloud-init
# reading user data and SSH keys from a NoCloud seed, like a provider would.
FROM ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv cloud-init openssh-server sudo ca-certificates curl iptables \
 && rm -rf /var/lib/apt/lists/* \
 && printf 'datasource_list: [NoCloud, None]\n' > /etc/cloud/cloud.cfg.d/90-quenda-sim.cfg
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
