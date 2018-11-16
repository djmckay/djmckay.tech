//
//  SocialTests.swift
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

class SocialTests: XCTestCase {

    var uri: String = "/api/socials/"
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
    
    func testSocialCanBeRetrievedFromAPI() throws {
        // This is an example of a functional test case.
        // Use XCTAssert and related functions to verify your tests produce the correct results.
        
        var social = try Social(url: "https://wwww.github.com", handle: "myid", icon: "someicon").save(on: conn).wait()
        
        
        
        
        let socials = try app.getResponse(to: uri, headers: headers, decodeTo: [Social].self)
        
        XCTAssertEqual(socials.count, 1)
        XCTAssertEqual(socials[0].url, social.url)
        XCTAssertEqual(socials[0].id, social.id)
        XCTAssertEqual(socials[0].handle, social.handle)
        XCTAssertEqual(socials[0].icon, social.icon)
    }
    
    func testSocialCanBeSavedWithAPI() throws {
        let social = Social(url: "https://wwww.github.com", handle: "myid2", icon: "someicon2")

        let foundItem = try app.getResponse(to: uri, method: .POST, headers: headers, data: social, decodeTo: Social.self)
        
        XCTAssertEqual(foundItem.url, social.url)
        XCTAssertEqual(foundItem.handle, social.handle)
        XCTAssertEqual(foundItem.icon, social.icon)
        XCTAssertNotNil(foundItem.id)
        
        let socials = try app.getResponse(to: uri, headers: headers, decodeTo: [Social].self)
        
        XCTAssertEqual(socials.count, 1)
        XCTAssertEqual(socials[0].url, foundItem.url)
        XCTAssertEqual(socials[0].id, foundItem.id)
        XCTAssertEqual(socials[0].handle, foundItem.handle)
        XCTAssertEqual(socials[0].icon, foundItem.icon)
    }
    
    func testSocialCanBeUpdateWithAPI() throws {
        let social = try Social(url: "https://wwww.github.com", handle: "myid2", icon: "someicon2").save(on: conn).wait()
        
        social.url = "https://www.updated.com"
        social.handle = "mynewid"
        social.icon = "somenewicon"
        
        let foundItem = try app.getResponse(to: "\(uri)\(social.id!)", method: .PUT, headers: headers, data: social, decodeTo: Social.self)
        
        XCTAssertEqual(foundItem.url, social.url)
        XCTAssertEqual(foundItem.handle, social.handle)
        XCTAssertEqual(foundItem.icon, social.icon)
        XCTAssertNotNil(foundItem.id)
        
        let socials = try app.getResponse(to: uri, headers: headers, decodeTo: [Social].self)
        
        XCTAssertEqual(socials.count, 1)
        XCTAssertEqual(socials[0].url, foundItem.url)
        XCTAssertEqual(socials[0].id, foundItem.id)
        XCTAssertEqual(socials[0].handle, foundItem.handle)
        XCTAssertEqual(socials[0].icon, foundItem.icon)
    }
    
    func testSocialCanBeDeletedWithAPI() throws {
        let social = try Social(url: "https://wwww.github.com", handle: "myid2", icon: "delete this").save(on: conn).wait()
        
        var socials = try app.getResponse(to: uri, headers: headers, decodeTo: [Social].self)
        
        XCTAssertEqual(socials.count, 1)
        
        _ = try app.sendRequest(to: "\(uri)\(social.id!)", method: .DELETE, headers: headers)
        
        socials = try app.getResponse(to: uri, headers: headers, decodeTo: [Social].self)
        
        XCTAssertEqual(socials.count, 0)
        
    }

}
