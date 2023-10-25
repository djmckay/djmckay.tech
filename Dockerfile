# Build image
FROM swift:5.3.2-focal as build

RUN apt-get update -y \
    && apt-get install -y libsqlite3-dev

WORKDIR /build

COPY . .

RUN swift build \
    --enable-test-discovery \
    -c release \
    -Xswiftc -g

# Run image
FROM swift:5.3.2-focal-slim

RUN useradd --user-group --create-home --home-dir /app vapor

WORKDIR /app

COPY --from=build --chown=vapor:vapor /build/.build/release /app
COPY --from=build --chown=vapor:vapor /build/Public /app/Public
COPY --from=build --chown=vapor:vapor /build/Resources /app/Resources

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

RUN echo "DB_HOST=${DATABASE_AWS_HOSTNAME}" >> .env.production
# RUN echo "DB_PORT=${AWS_RDS_PORT}" >> .env.production
RUN echo "DB_USER=${DATABASE_AWS_USER}" >> .env.production
RUN echo "DB_PASS=${DATABASE_AWS_PASSWORD}" >> .env.production
RUN echo "DB_NAME=${DATABASE_AWS_DB}" >> .env.production

USER vapor

# Export Port
EXPOSE 8080

ENTRYPOINT ["./Run"]
CMD ["serve", "--env", "production", "--hostname", "0.0.0.0", "--port", "8080"]
