// swift-tools-version:4.0
import PackageDescription

let package = Package(
    name: "djmckay.tech",
    dependencies: [
        // 💧 A server-side Swift web framework.
        .package(url: "https://github.com/vapor/vapor.git", from: "3.0.0"),
        
        // 🍃 An expressive, performant, and extensible templating language built for Swift.
        .package(url: "https://github.com/vapor/fluent-mysql.git", from: "3.0.0-rc"),
        .package(url: "https://github.com/vapor/leaf.git", from: "3.0.0-rc"),
        .package(url: "https://github.com/vapor/jwt.git", from: "3.0.0"),
        .package(url: "https://github.com/vapor/auth.git", from: "2.0.0-rc"),
        .package(url: "https://github.com/vapor/console.git", from: "3.0.0"),
        .package(url: "https://github.com/vapor/multipart.git", from: "3.0.0"),
        ],
    targets: [
        .target(name: "App", dependencies: ["FluentMySQL", "Vapor", "Authentication", "JWT", "Leaf", "Logging", "Multipart"]),
        .target(name: "Run", dependencies: ["App"]),
        .testTarget(name: "AppTests", dependencies: ["App"])
    ]
)
