//
//  BaseModel.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Foundation
import Vapor
import FluentMySQL

protocol BaseModel: MySQLUUIDModel {
    
    associatedtype Public
    func convertToPublic() -> Public
    
    //    static var createdAtKey: TimestampKey? { get }
    //    static var updatedAtKey: TimestampKey? { get }
    //    var createdAt: Date? { get set }
    //    var updatedAt: Date? { get set }
}



protocol BaseUserTrackable: BaseModel {
    
    static var createdAtKey: TimestampKey? { get }
    static var updatedAtKey: TimestampKey? { get }
    var createdAt: Date? { get set }
    var updatedAt: Date? { get set }
}
