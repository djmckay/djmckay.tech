//
//  ProjectMigrations.swift
//  App
//
//  Created by DJ McKay on 11/20/18.
//

import Vapor
import FluentMySQL
import Authentication

struct ProjectMigrationAddGallery: Migration {
    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Project.self, on: conn, closure: { (builder) in
            builder.field(for: \.galleryURL)
        })
    }
    
    static func revert(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Project.self, on: conn, closure: { (builder) in
            builder.deleteField(for: \.galleryURL)
        })
    }
    
    typealias Database = MySQLDatabase
    
    
}
