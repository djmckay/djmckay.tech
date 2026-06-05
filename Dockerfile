FROM swift:5.2 as builder

ARG env=""
ENV ENVIRONMENT=$env

RUN apt-get -qq update && apt-get -q -y install \
  tzdata \
  && rm -r /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN mkdir -p /build/lib && cp -R /usr/lib/swift/linux/*.so* /build/lib
RUN swift build -c release --verbose 2>&1 | tail -50 && mv `swift build -c release --show-bin-path` /build/bin

# Production image
FROM ubuntu:18.04
RUN apt-get -qq update && apt-get install -y \
  libicu60 libxml2 libbsd0 libcurl4 libatomic1 \
  libssl1.1 \
  tzdata \
  && rm -r /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/bin/Run .
COPY --from=builder /build/lib/* /usr/lib/
COPY --from=builder /app/Public ./Public
COPY --from=builder /app/Resources ./Resources

USER root
EXPOSE 8080
ENTRYPOINT ./Run serve --env production --hostname 0.0.0.0 --port 8080
