import Leaf
import Vapor
import FluentMySQL

/// Called before your application initializes.
public func configure(_ config: inout Config, _ env: inout Environment, _ services: inout Services) throws {
    /// Register providers first
    try services.register(FluentMySQLProvider())
    try services.register(LeafProvider())
    try services.register(BespinProvider())
    services.register(LoggerMiddleware.self)

    /// Register routes to the router
    let router = EngineRouter.default()
    try routes(router)
    services.register(router, as: Router.self)
    /// Use Leaf for rendering views
    config.prefer(LeafRenderer.self, for: ViewRenderer.self)
    services.register { container -> LeafTagConfig in
        var config = LeafTagConfig.default()
        config.use(PrintHTML(), as: "html")
        return config
    }
    /// Register middleware
    var middlewares = MiddlewareConfig() // Create _empty_ middleware config
    middlewares.use(FileMiddleware.self) // Serves files from `Public/` directory
    middlewares.use(ErrorMiddleware.self) // Catches errors and converts to HTTP response
    middlewares.use(LoggerMiddleware.self)
    services.register(middlewares)
    
//    if env != .production {
        var databases = DatabasesConfig()
    print(env.name)
        if env == .testing || env == .development {
            databases.add(database: DJMcKayTech.DJMcKayTechTest, as: .DJMcKayTech)
            print("testing or dev?")
            print(DJMcKayTech.DJMcKayTechTest.config)
        } else {
            databases.add(database: DJMcKayTech.DJMcKayTech, as: .DJMcKayTech)
            print(DJMcKayTech.DJMcKayTech.config)
        }
    
        services.register(databases)
        /// Configure migrations
        var migrations = MigrationConfig()
        migrations.add(model: Project.self, database: .DJMcKayTech)
        migrations.add(model: Social.self, database: .DJMcKayTech)
        migrations.add(model: Site.self, database: .DJMcKayTech)
        migrations.add(model: Skill.self, database: .DJMcKayTech)
        migrations.add(model: Education.self, database: .DJMcKayTech)
        migrations.add(model: Experience.self, database: .DJMcKayTech)
        migrations.add(model: Profile.self, database: .DJMcKayTech)
    if env != .testing {
        //migrations.add(migration: SiteMigrationAddAboutHeader.self, database: .DJMcKayTech)
        //migrations.add(migration: ProfileMigrationAddDownloadURL.self, database: .DJMcKayTech)
//        migrations.add(migration: EducationMigrationAddSort.self, database: .DJMcKayTech)
//        migrations.add(migration: ProjectMigrationAddSort.self, database: .DJMcKayTech)
//        migrations.add(migration: ExperienceMigrationAddSort.self, database: .DJMcKayTech)
    }
    //migrations.prepareCache(for: .DJMcKayTech)

        services.register(migrations)
//
        var commandConfig = CommandConfig.default()
        commandConfig.useFluentCommands()
        services.register(commandConfig)
//    }
    
    
}

struct DJMcKayTech {
    static fileprivate let DatabaseUsername: String = Environment.get("DATABASE_USER") ?? Environment.get("DATABASE_AWS_USER") ?? "djmckaytech"
    static fileprivate let DatabasePassword: String = Environment.get("DATABASE_PASSWORD") ?? Environment.get("DATABASE_AWS_PASSWORD") ?? "password"
    
    static let DJMcKayTechConfig = MySQLDatabaseConfig(hostname: Environment.get("DATABASE_HOSTNAME") ?? Environment.get("DATABASE_AWS_HOSTNAME") ?? "localhost", port: 3306, username: DatabaseUsername, password: DatabasePassword, database: Environment.get("DATABASE_DB") ?? Environment.get("DATABASE_AWS_DB") ?? "DJMcKayTech")
    static let DJMcKayTech = MySQLDatabase(config: DJMcKayTechConfig)
    
    static let DJMcKayTechConfigTest = MySQLDatabaseConfig(hostname: Environment.get("DATABASE_HOSTNAME") ?? Environment.get("DATABASE_AWS_HOSTNAME") ?? "localhost", port: Int(Environment.get("DATABASE_AWS_PORT") ?? "3308") ?? 3308, username: DatabaseUsername, password: DatabasePassword, database: Environment.get("DATABASE_DB") ?? Environment.get("DATABASE_AWS_DB") ?? "DJMcKayTech-test")
    static let DJMcKayTechTest = MySQLDatabase(config: DJMcKayTechConfigTest)
}

extension DatabaseIdentifier {
    /// Default identifier for `MySQLDatabase`.
    public static var DJMcKayTech: DatabaseIdentifier<MySQLDatabase> {
        return .init("DJMcKayTech")
    }
}
