//
//  BespinClient.swift
//  App
//
//  Created by DJ McKay on 11/15/18.
//

import Vapor
import JWT

public final class BespinClient: Service {
    let httpClient: Client
    //    let apiKey: String
    let apiEndpoint = "https://bespin-mail-api.vapor.cloud/api/"
    //    public let domain: String
    
    //    public init(client: Client, apiKey: String, domain: String) {
    //        self.httpClient = client
    //        self.apiKey = apiKey
    //        self.domain = domain
    //    }
    var logger: Logger
    
    public init(client: Client, logger: Logger) {
        self.httpClient = client
        self.logger = logger
    }
    
    public func send<E>(_ email: E, on worker: Worker) throws -> Future<Response> where E: Content {
        var headers: HTTPHeaders = [:]
//djmckay.tech
        let domain = "djmckay.tech"
        let token = Environment.get("BESPIN_TOKEN") ?? Bundle(for: BespinClient.self).infoDictionary?["BESPIN_TOKEN"] as? String ?? Environment.get("BESPIN_TOKEN") ?? "<TOKEN>"
        let key = Environment.get("BESPIN_AUTH") ?? Bundle(for: BespinClient.self).infoDictionary?["BESPIN_AUTH"] as? String ?? "<TOKEN>"
//        let token = Bundle.main.infoDictionary?["BESPIN_TOKEN"] as? String ?? Environment.get("BESPIN_TOKEN") ?? "<TOKEN>"
//        let key = Bundle.main.infoDictionary?["BESPIN_AUTH"] as? String ?? Environment.get("BESPIN_AUTH") ?? "<apikey>"
        // create payload
        let webToken = WebToken(name: "name", key: token, domain: domain)
        
        // create JWT and sign
        let jwt = try! JWT(payload: webToken).sign(using: .hs256(key: key))
        headers = HTTPHeaders()
        headers.add(name: .authorization, value: "Bearer \(String(data: jwt, encoding: .utf8) ?? "")")
        headers.add(name: "Content-Type", value: "application/json")
        
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        
        print(apiEndpoint+token+"/messages")
        let request = httpClient.post(apiEndpoint+token+"/messages", headers: headers) { req in
            let data = try encoder.encode(email)
            print(String(data: data, encoding: .utf8)!)
            try req.content.encode(email)
        }
        return request.map { response in
            return try self.process(response)
        }
    }
    
    private func process(_ response: Response) throws -> Response {
        logger.verbose("[\(Date())] BespinClient processing: \(response.http.status)")
        switch true {
        case response.http.status.code == HTTPStatus.ok.code:
            return response
        case response.http.status.code == HTTPStatus.unauthorized.code:
            throw Error.authenticationFailed
        default:
            if let data = response.http.body.data, let err = (try? JSONDecoder().decode(ErrorResponse.self, from: data)) {
                throw Error.unableToSendEmail(err)
            }
            throw Error.unknownError(response)
        }
    }
    
    public enum Error: Debuggable {
        
        /// Encoding problem
        case encodingProblem
        
        /// Failed authentication
        case authenticationFailed
        
        /// Failed to send email (with error message)
        case unableToSendEmail(ErrorResponse)
        
        /// Generic error
        case unknownError(Response)
        
        /// Identifier
        public var identifier: String {
            switch self {
            case .encodingProblem:
                return "bespin.encoding_error"
            case .authenticationFailed:
                return "bespinn.auth_failed"
            case .unableToSendEmail:
                return "bespin.send_email_failed"
            case .unknownError:
                return "bespin.unknown_error"
            }
        }
        
        /// Reason
        public var reason: String {
            switch self {
            case .encodingProblem:
                return "Encoding problem"
            case .authenticationFailed:
                return "Failed authentication"
            case .unableToSendEmail(let err):
                return "Failed to send email (\(err.message))"
            case .unknownError:
                return "Generic error"
            }
        }
    }
    
    /// Error response object
    public struct ErrorResponse: Decodable {
        
        /// Error messsage
        public let message: String
        
    }
    
    /// Mailgun response object
    public struct BespinResponse: Content {
        
        /// messsage
        public let message: String
        public let id: String
    }
}

struct WebToken: JWTPayload {
    var name: String
    var key: String
    var domain: String
    
    func verify(using signer: JWTSigner) throws {
        // nothing to verify
        print("nothing to verify")
        print(self.key)
    }
}


public struct Message: Content {
    public static let defaultContentType: MediaType = .urlEncodedForm
    /// An array of messages and their metadata. Each object within personalizations can be thought of as an envelope - it defines who should receive an individual message and how that message should be handled.
    public var to: [EmailAddress]?
    
    public var from: EmailAddress?
    
    public var cc: [EmailAddress]?
    
    public var bcc: [EmailAddress]?
    
    public var replyTo: EmailAddress?
    
    /// The global, or “message level”, subject of your email. This may be overridden by personalizations[x].subject.
    public var subject: String?
    
    /// An array in which you may specify the content of your email.
    public var text: String?
    public var html: String?
    
    /// An array of objects in which you can specify any attachments you want to include.
    public var deliveryTime: Date?
    
    public typealias RecipientVariables = [String: [String: String]]
    
    public var recipientVariables: RecipientVariables?
    public var template: String?
    
    public init(from: EmailAddress? = nil, replyTo: EmailAddress? = nil,
                cc: [EmailAddress]? = nil,
                bcc: [EmailAddress]? = nil,
                to: [EmailAddress]? = nil,
                text: String? = nil,
                html: String? = nil,
                subject: String? = nil,
                recipientVariables: RecipientVariables? = nil, template: String? = nil) {
        self.from = from
        self.replyTo = replyTo
        self.to = to
        self.cc = cc
        self.bcc = bcc
        self.text = text
        self.html = html
        self.subject = subject
        self.recipientVariables = recipientVariables
        self.template = template
        
    }
    
    public enum CodingKeys: String, CodingKey {
        case from
        case replyTo = "h:Reply-To"
        case to
        case cc
        case bcc
        case text
        case html
        case subject
        case recipientVariables = "recipient-variables"
        case template
        case deliveryTime
    }
}

public struct EmailAddress: Content {
    /// format: "Bob <bob@host.com>"
    public var email: String?
    public var rawEmail: String?
    
    public init(email: String,
                name: String? = nil) {
        self.rawEmail = email
        self.email = "\(name ?? "") <\(email)>"
    }
}

extension Array where Element == EmailAddress {
    
    var stringArray: [String] {
        return map { entry -> String in
            return entry.email ?? ""
        }
    }
}

