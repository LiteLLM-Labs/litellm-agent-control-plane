FROM node:20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash alice \
    && echo 'alice:test-password' | chpasswd \
    && mkdir -p /run/sshd /home/alice/workspace \
    && chown -R alice:alice /home/alice/workspace \
    && printf '\nPasswordAuthentication yes\nPubkeyAuthentication yes\nPermitRootLogin no\n' >> /etc/ssh/sshd_config

COPY fake-codex.mjs /usr/local/bin/codex
RUN chmod 0755 /usr/local/bin/codex

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
