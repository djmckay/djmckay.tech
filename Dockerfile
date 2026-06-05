FROM swift:4.2 as builder

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

# Replace FoundationClient with a stub that doesn't use URLSession
# RUN printf 'import Vapor\nimport Service\n\npublic final class FoundationClient: Client, ServiceType {\n    public static var serviceSupports: [Any.Type] { return [Client.self] }\n    public static func makeService(for worker: Container) throws -> FoundationClient {\n        return FoundationClient(on: worker)\n    }\n    public var container: Container\n    public init(on container: Container) { self.container = container }\n    public func send(_ req: Request) -> Future<Response> {\n        return req.eventLoop.newFailedFuture(error: Abort(.internalServerError, reason: "FoundationClient not supported"))\n    }\n}\n' > .build/checkouts/vapor/Sources/Vapor/Client/FoundationClient.swift

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

# Verify
RUN ls -la /app/Resources/Views/ && echo "Views OK"

USER root
EXPOSE 8080
ENTRYPOINT ./Run serve --env production --hostname 0.0.0.0 --port 8080
