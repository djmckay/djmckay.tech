//
//  ProjectsTests.swift
//  AppTests
//
//  Created by DJ McKay on 11/15/18.
//

@testable import App
import Vapor
import XCTest
import FluentMySQL
import JWT
import Crypto

class ProjectsTests: XCTestCase {
    typealias T = Project
    
    var uri: String = "/api/projects/"
    var app: Application!
    var conn: MySQLConnection!
    var headers: HTTPHeaders!
    var social: Social!
    
    override func setUp() {
        // Put setup code here. This method is called before the invocation of each test method in the class.
        try! Application.reset()
        app = try! Application.testable()
        conn = try! app.newConnection(to: .DJMcKayTech).wait()
        headers = HTTPHeaders()
        // create payload
        let adminToken = AdminToken(key: "1234567890987654321")
        
        // create JWT and sign
        let jwt = try! JWT(payload: adminToken).sign(using: .hs256(key: "secret"))
        headers = HTTPHeaders()
        headers.add(name: .authorization, value: "Bearer \(String(data: jwt, encoding: .utf8) ?? "")")
        headers.add(name: "Content-Type", value: "application/json")
        
    }
    
    func testProjectCanBeRetrievedFromAPI() throws {
        // This is an example of a functional test case.
        // Use XCTAssert and related functions to verify your tests produce the correct results.
        
        var item = try T(name: "project name", description: "project description", url: "project url", github: "project repo", imageURL: nil).save(on: conn).wait()
        
        
        let items = try app.getResponse(to: uri, headers: headers, decodeTo: [T].self)
        
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].name, item.name)
        XCTAssertEqual(items[0].id, item.id)
        XCTAssertEqual(items[0].description, item.description)
        XCTAssertEqual(items[0].url, item.url)
        XCTAssertEqual(items[0].github, item.github)
        XCTAssertEqual(items[0].imageURL, item.imageURL)
    }
    
    func testProjectCanBeSavedWithAPI() throws {
        var item = try T(name: "project name", description: "project description", url: "project url", github: "project repo", imageURL: nil)

        let foundItem = try app.getResponse(to: uri, method: .POST, headers: headers, data: item, decodeTo: T.self)
        
        XCTAssertEqual(foundItem.imageURL, item.imageURL)
        XCTAssertEqual(foundItem.description, item.description)
        XCTAssertEqual(foundItem.name, item.name)
        XCTAssertEqual(foundItem.github, item.github)
        XCTAssertEqual(foundItem.url, item.url)
        XCTAssertNotNil(foundItem.id)
        
        let items = try app.getResponse(to: uri, headers: headers, decodeTo: [T].self)
        
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].name, foundItem.name)
        XCTAssertEqual(items[0].id, foundItem.id)
        XCTAssertEqual(items[0].description, foundItem.description)
        XCTAssertEqual(items[0].url, foundItem.url)
        XCTAssertEqual(items[0].github, foundItem.github)
        XCTAssertEqual(items[0].imageURL, foundItem.imageURL)
    }
    
    func testProjectCanBeUpdateWithAPI() throws {
        var item = try T(name: "project name", description: "project description", url: "project url", github: "project repo", imageURL: nil).save(on: conn).wait()
        
        item.imageURL = "imagem"
        item.name = "name 2"
        item.description = "new text"
        item.url = "url text"
        item.github = "new repo"
        
        let foundItem = try app.getResponse(to: "\(uri)\(item.id!)", method: .PUT, headers: headers, data: item, decodeTo: T.self)
        
        XCTAssertEqual(foundItem.imageURL, item.imageURL)
        XCTAssertEqual(foundItem.description, item.description)
        XCTAssertEqual(foundItem.name, item.name)
        XCTAssertEqual(foundItem.github, item.github)
        XCTAssertEqual(foundItem.url, item.url)
        XCTAssertNotNil(foundItem.id)
        
        let items = try app.getResponse(to: uri, headers: headers, decodeTo: [T].self)
        
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].imageURL, item.imageURL)
        XCTAssertEqual(items[0].description, item.description)
        XCTAssertEqual(items[0].name, item.name)
        XCTAssertEqual(items[0].github, item.github)
        XCTAssertEqual(items[0].url, item.url)
        XCTAssertEqual(items[0].id, foundItem.id)
    }
    
    func testProjectCanBeDeletedWithAPI() throws {
        var item = try T(name: "project name", description: "project description", url: "project url", github: "project repo", imageURL: nil).save(on: conn).wait()

        var items = try app.getResponse(to: uri, headers: headers, decodeTo: [T].self)
        
        XCTAssertEqual(items.count, 1)
        
        _ = try app.sendRequest(to: "\(uri)\(item.id!)", method: .DELETE, headers: headers)
        
        items = try app.getResponse(to: uri, headers: headers, decodeTo: [T].self)
        
        XCTAssertEqual(items.count, 0)
        
    }
    
}


