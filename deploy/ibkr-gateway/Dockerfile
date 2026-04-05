FROM eclipse-temurin:8-jre-jammy

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl sed \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ibkr

COPY deploy/ibkr-gateway/docker-entrypoint.sh /usr/local/bin/ibkr-gateway-entrypoint

RUN chmod +x /usr/local/bin/ibkr-gateway-entrypoint \
  && mkdir -p /opt/ibkr/clientportal.gw

EXPOSE 5000

ENTRYPOINT ["ibkr-gateway-entrypoint"]
