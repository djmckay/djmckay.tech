//
//  ProfileMigrations.swift
//  App
//
//  Created by DJ McKay on 11/17/18.
//

import Vapor
import FluentMySQL
import Authentication

struct ProfileMigrationAddDownloadURL: Migration {
    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Profile.self, on: conn, closure: { (builder) in
            builder.field(for: \.downloadURL)
        })
    }
    
    static func revert(on conn: MySQLConnection) -> EventLoopFuture<Void> {
        return MySQLDatabase.update(Profile.self, on: conn, closure: { (builder) in
            builder.deleteField(for: \.downloadURL)
        })
    }
    
    typealias Database = MySQLDatabase
    
    
}

//struct ProfileMigrationUpdateSummary: Migration {
//    static func prepare(on conn: MySQLConnection) -> EventLoopFuture<Void> {
//        return MySQLDatabase.update(Profile.self, on: conn, closure: { (builder) in
//            builder.deleteField(for: \.summary)
//            builder.field(for: \.summary, type: .longtext)
//        })
//    }
//    
//    static func revert(on conn: MySQLConnection) -> EventLoopFuture<Void> {
//        return .done(on: conn)
//    }
//    
//    typealias Database = MySQLDatabase
//    
//    
//}
