FROM swift:5.1 as builder

ARG env=""
ENV ENVIRONMENT=$env

RUN apt-get -qq update && apt-get -q -y install \
  tzdata \
  libssl-dev \
  && rm -r /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN mkdir -p /build/lib && cp -R /usr/lib/swift/linux/*.so* /build/lib

# Resolve packages first so we can patch the Vapor source
RUN swift package resolve

# Replace FoundationClient with a minimal stub that compiles
RUN cat > .build/checkouts/vapor/Sources/Vapor/Client/FoundationClient.swift << 'EOF'
import Foundation
import HTTP
import Service

public final class FoundationClient: Client {
    public var container: Container
    public init(on container: Container) { self.container = container }
    public func send(_ req: HTTPRequest, on worker: Worker) -> Future<HTTPResponse> {
        return worker.eventLoop.newFailedFuture(error: VaporError(identifier: "notSupported", reason: "FoundationClient not supported"))
    }
}
EOF

RUN swift build -c release && mv `swift build -c release --show-bin-path` /build/bin

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
