//
//  WebsiteController.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Vapor
import Leaf
import Fluent
import Authentication
import FluentMySQL
import JWT

struct WebsiteController: RouteCollection {
    func boot(router: Router) throws {
        router.get(use: indexHandler)
        router.post(ContactPostData.self, use: contactPostHandler)
        router.get("resume", use: resumeHandler)
        router.get("status") { (req) -> Future<View> in
            return try req.view().render("status", ["database": Environment.get("DATABASE_DB") ?? "missing", "database_host": Environment.get("DATABASE_HOSTNAME") ?? "missing host", "database_user": Environment.get("DATABASE_USER"), "configs": Environment.get("DATABASE_PASSWORD")])
        }
    }
    
    func contactPostHandler(_ req: Request, userData: ContactPostData) throws -> Future<View> {
        let bespin = try req.make(BespinClient.self)
        let form = ["name": userData.name, "phone": userData.phone, "message": userData.message, "email": userData.email]
        let bcc = Environment.get("BESPIN_BCC") ?? Bundle(for: BespinClient.self).infoDictionary?["BESPIN_BCC"] as? String ?? "<email>"
        let from = Environment.get("BESPIN_FROM") ?? Bundle(for: BespinClient.self).infoDictionary?["BESPIN_FROM"] as? String ?? "<email>"
        let variables = [userData.email : form, bcc: form ]
        let template = Environment.get("BESPIN_TEMPLATE") ?? Bundle(for: BespinClient.self).infoDictionary?["BESPIN_TEMPLATE"] as? String ?? "51807F8C-0B7E-4D08-9163-120ED821CAAC"
        let message = Message(from: EmailAddress(email: from), replyTo: nil, cc: nil, bcc: [EmailAddress(email: bcc)], to: [EmailAddress(email: userData.email)], text: nil, html: nil, subject: nil, recipientVariables: variables, template: template)
        _ = try bespin.send(message, on: req)
        
        return try indexHandler(req)
    }
    
    func indexHandler(_ req: Request) throws -> Future<View> {
        
        return flatMap(Project.query(on: req).all(), Site.query(on: req).first(), Social.query(on: req).all()) { (projects, site, socials) -> (EventLoopFuture<View>) in
            
            var socialContexts: [SocialContext] = []
            for social in socials {
                socialContexts.append(SocialContext(url: social.url, handle: social.handle, icon: social.icon))
            }
            var projectContexts: [ProjectContext] = []
            for project in projects {
                projectContexts.append(ProjectContext(name: project.name, description: project.description, url: project.url, github: project.github, imageURL: project.imageURL))
            }
            let indexContext: IndexContext = IndexContext(brand: site?.brand ?? "missing brand", socials: socialContexts, title: site?.title ?? "missing title", portfolio: PortfolioContext(projects: projectContexts))
            return try req.view().render("index", indexContext)
//            let thisSite = ProjectContext(name: "djmckay.tech", description: "My Portfolio site, djmckay.tech.  This site was built on server side <a href=\"https://swift.org/server/\">Swift</a> using <a href=\"https://vapor.codes\">Vapor</a>, deployed to <a href=\"https://vapor.cloud\">Vapor Cloud</a>.", url: "https://djmckay.tech", github: "djmckay/djmckay.tech", imageURL: "img/Artboard1.png")
//            let countdown = ProjectContext(name: "Countdown With Me", description: "iOS App serving as a reference application combining iOS, iMessage, WatchOS and CloudKit frameworks.", url: "https://itunes.apple.com/us/app/countdown-with-me/id1227308227?ls=1&mt=8", github: "djmckay/Countdown", imageURL: "img/Artboard1.png")
//            let vztuf = ProjectContext(name: "VZTUF Website", description: "Event hosting site.  Manages a yearly event by invitation only.  Registers attendees, creates invoices, receipts, fullfillment documents.  Allows attendees and exhibitors to manager attendees and their booth deliverables.  Frontend uses html, css, and javascript.  Backend is PHP and MySQL.", url: "https://www.vztuf.com", github: nil, imageURL: nil)
//
//            let vztufShowManagement = ProjectContext(name: "VZTUF Show Management App", description: "iOS App built for iPads.  Allows administrators to manage the VZTUF show.  Manage attending companies and exhibiting companies.  Provides a dashboard to manage invitations, revenue, payments, vendor kit, and attendees.  Uses JSON rest servies to communicate with backend database (PHP/MySQL).  Also provides MacOS desktop version with less features.  This is a B2B distribuited application.  You may visit the gallery to see demo screenshots.", url: nil, github: nil, imageURL: nil)
//
//            let vztufRegistrationDesk = ProjectContext(name: "VZTUF Registration App", description: "iOS App built for iPads.  Part of the VZTUF Suite.  This provides the registration desk features to find attendees and print their show badges.  Can register new attendees and take payments.  This is a B2B distribuited application.  You may visit the gallery to see demo screenshots.", url: nil, github: nil, imageURL: nil)
//
//            let vztufQRScanner = ProjectContext(name: "VZTUF QR Reader", description: "iOS App built for iPod Touches.  Part of the VZTUF Suite.  This provides the registration desk the ability to scan an attendees badge to mark them as checked in.  Indicating the badge which was printed, has been handed to the badge owner in an attempt to prevent fraud by reprinting badges.  Uses the device camera to read a QR code and communicate with backend system.  This is also used to scan for other tracking purposes.  Visiting a particular booth, track training and picking up their show gifts.  This is a B2B distribuited application.  You may visit the gallery to see demo screenshots.", url: nil, github: nil, imageURL: nil)
//
//            let bespin = ProjectContext(name: "Bespin Email Service", description: "Email API built on <a href=\"http://www.mailgun.com\" target=\"_blank\">Mailgun</a> adding email templates using Mustache.  Built using server side <a href=\"https://swift.org/server/\">Swift</a> and <a href=\"https://vapor.codes\">Vapor</a>, deployed to <a href=\"https://vapor.cloud\">Vapor Cloud</a>.  This project is currently a work in progress to offload resources for the VZTUF suite.", url: nil, github: "djmckay/Bespin", imageURL: nil)
//
//            let kamino = ProjectContext(name: "Kamino", description: "Event Management Web App", url: nil, github: "djmckay/kamino", imageURL: nil)
//
//            let socials = [SocialContext(url: "https://github.com/", handle: "djmckay", icon: "fa-github"), SocialContext(url: "https://www.linkedin.com/in/", handle: "djmckay17988844", icon: "fa-linkedin"), SocialContext(url: "https://www.twitter.com/", handle: "dj_mckay", icon: "fa-twitter-square")]
//            //SocialContext(github: "djmckay", linkedIn: "djmckay17988844", twitter: "dj_mckay", facebook: nil)
//            let context = IndexContext(brand: "DJ McKay", socials: socials, title: "DJ McKay.tech", portfolio: PortfolioContext(projects: [thisSite, countdown, vztuf, vztufShowManagement, vztufRegistrationDesk, vztufQRScanner, bespin, kamino]))
//            return try req.view().render("index", context)
            
        }
        
        
    }
    
    func resumeHandler(_ req: Request) throws -> Future<View> {
        return try! ResumePage.render(req)
        
    }
}


protocol BaseContext: Encodable {
    var brand: String { get set }
    var socials: [SocialContext] { get set }
    var title: String { get set }
}

struct IndexContext: BaseContext {
    var brand: String
    var socials: [SocialContext]
    var title: String
    var portfolio: PortfolioContext
}

struct PortfolioContext: Encodable {
    var projects: [ProjectContext]
}


struct ProjectContext: Encodable {
    var name: String
    var description: String
    var url: String?
    var github: String?
    var imageURL: String?
}

struct SocialContext: Encodable {
    var url: String?
    var handle: String?
    var icon: String?
}

struct ContactPostData: Content {
    let name: String
    let email: String
    let phone: String
    let message: String
}


