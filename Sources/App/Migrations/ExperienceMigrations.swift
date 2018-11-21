//
//  ExperienceMigrations.swift
//  App
//
//  Created by DJ McKay on 11/21/18.
//

import Vapor
import FluentMySQL
import Authentication

struct ExperienceMigrationAddUrl: Migration {
    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Experience.self, on: conn, closure: { (builder) in
            builder.field(for: \.url)
        })
    }
    
    static func revert(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Experience.self, on: conn, closure: { (builder) in
            builder.deleteField(for: \.url)
        })
    }
    
    typealias Database = MySQLDatabase
    
    
}
