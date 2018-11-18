// swift-tools-version:4.0
// Generated automatically by Perfect Assistant
// Date: 2018-11-18 00:34:32 +0000
import PackageDescription

let package = Package(
	name: "djmckay.tech",
	dependencies: [
		.package(url: "https://github.com/vapor/vapor.git", "3.0.0"..<"4.0.0"),
		.package(url: "https://github.com/vapor/fluent-mysql.git", "3.0.0-rc"..<"4.0.0"),
		.package(url: "https://github.com/vapor/leaf.git", "3.0.0-rc"..<"4.0.0"),
		.package(url: "https://github.com/vapor/jwt.git", "3.0.0"..<"4.0.0"),
		.package(url: "https://github.com/vapor/auth.git", "2.0.0-rc"..<"3.0.0"),
		.package(url: "https://github.com/vapor/console.git", "3.0.0"..<"4.0.0"),
		.package(url: "https://github.com/vapor/multipart.git", "3.0.0"..<"4.0.0")
	],
	targets: [
		.target(name: "App", dependencies: ["FluentMySQL", "Vapor", "Authentication", "JWT", "Leaf", "Logging", "Multipart"]),
		.target(name: "Run", dependencies: ["App"]),
		.target(name: "AppTests", dependencies: ["App"])
	]
)