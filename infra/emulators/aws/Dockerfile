# AWS publishes the emulator as RPM packages, not as an image:
# https://docs.aws.amazon.com/emulator/latest/userguide/getting-started-docker.html
FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) exit 1 ;; esac \
 && curl -fsSL -o /tmp/aws-emulator.rpm \
    "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-$arch.rpm" \
 && rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
 && mkdir -p /home/emulator/.aws/emulator && chown -R 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator EMULATOR_TELEMETRY=off
EXPOSE 9297
ENTRYPOINT ["aws-emulator", "-b", "0.0.0.0"]
