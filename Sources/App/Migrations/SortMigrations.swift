//
//  SortMigrations.swift
//  App
//
//  Created by DJ McKay on 11/17/18.
//

import Vapor
import FluentMySQL
import Authentication

struct ProjectMigrationAddSort: Migration {
    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Project.self, on: conn, closure: { (builder) in
            builder.field(for: \.sort)
        })
    }
    
    static func revert(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Project.self, on: conn, closure: { (builder) in
            builder.deleteField(for: \.sort)
        })
    }
    
    typealias Database = MySQLDatabase
    
    
}

struct ExperienceMigrationAddSort: Migration {
    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Experience.self, on: conn, closure: { (builder) in
            builder.field(for: \.sort)
        })
    }
    
    static func revert(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Experience.self, on: conn, closure: { (builder) in
            builder.deleteField(for: \.sort)
        })
    }
    
    typealias Database = MySQLDatabase
    
    
}

struct EducationMigrationAddSort: Migration {
    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Education.self, on: conn, closure: { (builder) in
            builder.field(for: \.sort)
        })
    }
    
    static func revert(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Education.self, on: conn, closure: { (builder) in
            builder.deleteField(for: \.sort)
        })
    }
    
    typealias Database = MySQLDatabase
    
    
}
