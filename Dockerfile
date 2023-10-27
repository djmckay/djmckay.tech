# You can set the Swift version to what you need for your app. Versions can be found here: https://hub.docker.com/_/swift
FROM swift:4.2 as builder

# For local build, add `--build-arg environment=local`
ARG env=""
ENV ENVIRONMENT=$env

RUN apt-get -qq update && apt-get -q -y install \
  tzdata \
  && rm -r /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN mkdir -p /build/lib && cp -R /usr/lib/swift/linux/*.so /build/lib
RUN swift build -c release && mv `swift build -c release --show-bin-path` /build/bin

# Production image
FROM ubuntu:16.04
RUN apt-get -qq update && apt-get install -y \
  libicu55 libxml2 libbsd0 libcurl3 libatomic1 \
  tzdata \
  && rm -r /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/bin/Run .
COPY --from=builder /build/lib/* /usr/lib/
COPY --from=builder /app/Public ./Public
COPY --from=builder /app/Resources ./Resources

# ARS RDS Environment ARG
ARG DATABASE_AWS_HOSTNAME
# ARG AWS_RDS_PORT
ARG DATABASE_AWS_USER
ARG DATABASE_AWS_PASSWORD
ARG DATABASE_AWS_DB

# SignInWithApple Environment ARG
ARG SIWA_ID
ARG SIWA_REDIRECT_URL
ARG SIWA_JWK_ID
ARG SIWA_PRIVATE_KEY
ARG SIWA_TEAM_ID
ARG SIWA_APP_BUNDLE_ID

# Set Environment
RUN echo "SIWA_ID=${SIWA_ID}" > .env.production
RUN echo "SIWA_REDIRECT_URL=${SIWA_REDIRECT_URL}" >> .env.production
RUN echo "SIWA_JWK_ID=${SIWA_JWK_ID}" >> .env.production
RUN echo "SIWA_PRIVATE_KEY=${SIWA_PRIVATE_KEY}" >> .env.production
RUN echo "SIWA_TEAM_ID=${SIWA_TEAM_ID}" >> .env.production
RUN echo "SIWA_APP_BUNDLE_ID=${SIWA_APP_BUNDLE_ID}" >> .env.production

RUN echo "DATABASE_AWS_HOSTNAME=${DATABASE_AWS_HOSTNAME}" >> .env.production
# RUN echo "DB_PORT=${AWS_RDS_PORT}" >> .env.production
RUN echo "DATABASE_AWS_USER=${DATABASE_AWS_USER}" >> .env.production
RUN echo "DATABASE_AWS_PASSWORD=${DATABASE_AWS_PASSWORD}" >> .env.production
RUN echo "DATABASE_AWS_DB=${DATABASE_AWS_DB}" >> .env.production

USER root

# Export Port
EXPOSE 8080
ENTRYPOINT ./Run serve --env production --hostname 0.0.0.0 --port 8080 \
-e DATABASE_AWS_HOSTNAME=${DATABASE_AWS_HOSTNAME} \ 
-e DATABASE_AWS_USER=${DATABASE_AWS_USER} \ 
-e DATABASE_AWS_PASSWORD=${DATABASE_AWS_PASSWORD} \ 
-e DATABASE_AWS_DB=${DATABASE_AWS_DB} 
# ENTRYPOINT ["./Run"]
# CMD ["serve", "--env", "production", "--hostname", "0.0.0.0", "--port", "8080"]
