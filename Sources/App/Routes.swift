import Vapor

/// Register your application's routes here.
public func routes(_ router: Router) throws {
    // "It works" page
    router.get { req -> Future<View> in
        
        let thisSite = Project(name: "djmckay.tech", description: "My Portfolio site, djmckay.tech.  This site was built on server side <a href=\"https://swift.org/server/\">Swift</a> using <a href=\"https://vapor.codes\">Vapor</a>, deployed to <a href=\"https://vapor.cloud\">Vapor Cloud</a>.", url: "https://djmckay.tech", github: "djmckay/djmckay.tech", imageURL: "img/Artboard1.png")
        let countdown = Project(name: "Countdown With Me", description: "iOS App serving as a reference application combining iOS, iMessage and WatchOS frameworks.", url: "https://itunes.apple.com/us/app/countdown-with-me/id1227308227?ls=1&mt=8", github: "djmckay/Countdown", imageURL: "img/Artboard1.png")
        let vztuf = Project(name: "VZTUF Website", description: "Event hosting site.  Manages a yearly event by invitation only.  Registers attendees, creates invoices, receipts, fullfillment documents.  Allows attendees and exhibitors to manager attendees and their booth deliverables.  Frontend uses html, css, and javascript.  Backend is PHP and MySQL.", url: "https://www.vztuf.com", github: nil, imageURL: nil)
        
        let vztufShowManagement = Project(name: "VZTUF Show Management App", description: "iOS App built for iPads.  Allows administrators to manage the VZTUF show.  Manage attending companies and exhibiting companies.  Provides a dashboard to manage invitations, revenue, payments, vendor kit, and attendees.  Uses JSON rest servies to communicate with backend database (PHP/MySQL).  Also provides MacOS desktop version with less features.  This is a B2B distribuited application.  You may visit the gallery to see demo screenshots.", url: nil, github: nil, imageURL: nil)
        
        let vztufRegistrationDesk = Project(name: "VZTUF Registration App", description: "iOS App built for iPads.  Part of the VZTUF Suite.  This provides the registration desk find attendees and print their show badges.  Can register new attendees and take payments.  This is a B2B distribuited application.  You may visit the gallery to see demo screenshots.", url: nil, github: nil, imageURL: nil)
        
        let vztufQRScanner = Project(name: "VZTUF QR Reader", description: "iOS App built for iPod Touches.  Part of the VZTUF Suite.  This provides the registration desk the ability to scan an attendees badge to mark them as checked in.  Indicating the badge which was printed, has been handed to the badge owner in an attempt to prevent fraud by reprinting badges.  Uses the device camera to read a QR code and communicate with backend system.  This is also used to scan for other tracking purposes.  Visiting a particular booth, track training and picking up their show gifts.  This is a B2B distribuited application.  You may visit the gallery to see demo screenshots.", url: nil, github: nil, imageURL: nil)
        
        let bespin = Project(name: "Bespin Email Service", description: "Email API built on <a href=\"http://www.mailgun.com\" target=\"_blank\">Mailgun</a> adding email templates using Mustache.  Built using server side <a href=\"https://swift.org/server/\">Swift</a> and <a href=\"https://vapor.codes\">Vapor</a>, deployed to <a href=\"https://vapor.cloud\">Vapor Cloud</a>.  This project is currently a work in progress to offload resources for the VZTUF suite.", url: nil, github: "djmckay/Bespin", imageURL: nil)
        let context = IndexContext(brand: "DJ McKay", social: Social(github: "djmckay", linkedIn: "djmckay17988844", twitter: "dj_mckay", facebook: nil), portfolio: Portfolio(projects: [thisSite, countdown, vztuf, vztufShowManagement, vztufRegistrationDesk, vztufQRScanner, bespin]))
        return try req.view().render("index", context)
    }
    
    router.get("resume") { req -> Future<View> in
        let context = BaseContext(brand: "DJ McKay", social: Social(github: "djmckay", linkedIn: "djmckay17988844", twitter: "dj_mckay", facebook: nil))
        return try! req.make(ViewRenderer.self).render("resume", context)
        
    }
}

struct BaseContext: Encodable {
    var brand: String
    var social: Social
}

struct IndexContext: Encodable {
    var brand: String
    var social: Social
    var portfolio: Portfolio
}

struct Portfolio: Encodable {
    var projects: [Project]
}


struct Project: Encodable {
    var name: String
    var description: String
    var url: String?
    var github: String?
    var imageURL: String?
}

struct Social: Encodable {
    var github: String?
    var linkedIn: String?
    var twitter: String?
    var facebook: String?
}
