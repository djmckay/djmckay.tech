//
//  SiteMigrations.swift
//  App
//
//  Created by DJ McKay on 11/17/18.
//

import Vapor
import FluentMySQL
import Authentication

struct SiteMigrationAddAboutHeader: Migration {
    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Site.self, on: conn, closure: { (builder) in
            builder.field(for: \.about)
            builder.field(for: \.header)
        })
    }
    
    static func revert(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return .done(on: conn)
    }
    
    typealias Database = MySQLDatabase
    
    
}

struct SiteMigrationAddAvatar: Migration {
    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Site.self, on: conn, closure: { (builder) in
            builder.field(for: \.avatar)
            builder.field(for: \.avatarByLine)
        })
    }
    
    static func revert(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Site.self, on: conn, closure: { (builder) in
            builder.deleteField(for: \.avatar)
            builder.deleteField(for: \.avatarByLine)
        })
    }
    
    typealias Database = MySQLDatabase
    
    
}
