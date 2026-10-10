import { SEOHead } from "@/components/seo-head";
import { BackHeader } from "@/components/back-header";
import { Button } from "@/components/ui/button";
import { ProgressiveContactLink } from "@/components/progressive-contact-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  Mail, 
  MapPin,
  Send,
  HelpCircle,
  Users,
  Building,
  Clock
} from "lucide-react";

export default function Contact() {
  const schemaData = {
    "@context": "https://schema.org",
    "@type": "ContactPage",
    "mainEntity": {
      "@type": "Organization",
      "name": "MealScout",
      "contactPoint": {
        "@type": "ContactPoint",
        "contactType": "customer service",
        "email": "support@mealscout.us",
        "availableLanguage": "English"
      }
    }
  };

  const contactMethods = [
    {
      title: "General Support",
      description: "Questions about using MealScout, technical issues, or account help",
      icon: HelpCircle,
      contact: "support@mealscout.us",
      response: "Within 24 hours",
      color: "bg-[color:var(--accent-text)]/12 text-[color:var(--accent-text)]"
    },
    {
      title: "Restaurant Partnerships",
      description: "Interested in joining MealScout as a restaurant partner",
      icon: Building,
      contact: "support@mealscout.us",
      response: "Within 24 hours",
      color: "bg-[color:var(--status-success)]/12 text-[color:var(--status-success)]"
    },
    {
      title: "Press & Media",
      description: "Media inquiries, press releases, and partnership opportunities",
      icon: Users,
      contact: "support@mealscout.us",
      response: "Within 24 hours",
      color: "bg-purple-100 text-purple-600"
    }
  ];

  const supportEmail = "support@mealscout.us";

  const quickHelp = [
    "How do I get started?",
    "How do parking passes work?",
    "Where do I manage my profile?",
    "How do events work?",
    "How do affiliate links work?",
    "Report a problem"
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 via-pink-50 to-red-50">
      <SEOHead
        title="Contact MealScout - Email Support"
        description="Email MealScout support for help with accounts, parking passes, events, restaurants, bars, and food trucks."
        keywords="contact MealScout, MealScout support email, food truck support, parking pass help, host account help, restaurant onboarding support"
        canonicalUrl="https://www.mealscout.us/contact"
        schemaData={schemaData}
      />
      
      <BackHeader
        title="Contact Us"
        fallbackHref="/"
        icon={Mail}
        className="bg-[hsl(var(--background))/0.94] border-b border-[color:var(--border-subtle)] shadow-clean"
      />

      <div className="px-4 py-8 max-w-6xl mx-auto">
        {/* Hero Section */}
        <div className="text-center mb-16">
          <div className="w-24 h-24 bg-gradient-to-br from-purple-500 via-pink-500 to-red-500 rounded-3xl mb-8 flex items-center justify-center mx-auto shadow-clean-lg">
            <Mail className="w-12 h-12 text-white" />
          </div>
          <h1 className="text-4xl font-bold text-[color:var(--text-primary)] mb-6">
            Email Support
          </h1>
          <p className="text-xl text-[color:var(--text-secondary)] leading-relaxed max-w-3xl mx-auto">
            Have a question or need help? Email us and include the page you were on.
          </p>
        </div>

        {/* Contact Methods */}
        <div className="grid lg:grid-cols-3 gap-8 mb-16">
          {contactMethods.map((method, index) => {
            const IconComponent = method.icon;
            return (
              <Card key={index} className="p-6 bg-[var(--bg-card)] border border-[color:var(--border-subtle)] shadow-clean-lg hover:shadow-clean-lg transition-shadow">
                <CardContent className="p-0 text-center">
                  <div className={`w-16 h-16 ${method.color} rounded-2xl flex items-center justify-center mx-auto mb-6`}>
                    <IconComponent className="w-8 h-8" />
                  </div>
                  <h3 className="text-xl font-bold text-[color:var(--text-primary)] mb-3">{method.title}</h3>
                  <p className="text-[color:var(--text-secondary)] mb-6 leading-relaxed">{method.description}</p>
                  <div className="space-y-2 mb-6">
                    <div className="flex items-center justify-center space-x-2 text-sm text-[color:var(--text-secondary)]">
                      <Mail className="w-4 h-4" />
                      <span>{method.contact}</span>
                    </div>
                    <div className="flex items-center justify-center space-x-2 text-sm text-[color:var(--text-secondary)]">
                      <Clock className="w-4 h-4" />
                      <span>Response: {method.response}</span>
                    </div>
                  </div>
                  <Button
                    asChild
                    className="w-full bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600 text-white"
                  >
                    <ProgressiveContactLink href={`mailto:${supportEmail}?subject=${encodeURIComponent(method.title)}`}>
                      <Mail className="w-4 h-4 mr-2" />
                      Send Email
                    </ProgressiveContactLink>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="space-y-8">
            {/* Quick Help */}
            <Card className="bg-[var(--bg-card)] border border-[color:var(--border-subtle)] shadow-clean-lg">
              <CardHeader>
                <CardTitle className="text-xl font-bold text-[color:var(--text-primary)] flex items-center gap-3">
                  <HelpCircle className="w-5 h-5 text-[color:var(--accent-text)]" />
                  Quick Help Topics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {quickHelp.map((topic, index) => (
                    <button
                      key={index}
                      className="w-full text-left p-3 rounded-lg bg-[var(--bg-surface)] hover:bg-[color:var(--accent-text)]/10 hover:text-[color:var(--accent-text)] transition-colors text-sm"
                      data-testid={`button-quick-help-${index}`}
                    >
                      {topic}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Office Info */}
            <Card className="bg-[var(--bg-card)] border border-[color:var(--border-subtle)] shadow-clean-lg">
              <CardHeader>
                <CardTitle className="text-xl font-bold text-[color:var(--text-primary)] flex items-center gap-3">
                  <MapPin className="w-5 h-5 text-[color:var(--status-success)]" />
                  Our Information
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start space-x-3">
                  <Mail className="w-5 h-5 text-[color:var(--text-muted)] mt-0.5" />
                  <div>
                    <div className="font-semibold text-[color:var(--text-primary)]">Email</div>
                    <div className="text-[color:var(--text-secondary)]">support@mealscout.us</div>
                  </div>
                </div>
                
                <div className="flex items-start space-x-3">
                  <MapPin className="w-5 h-5 text-[color:var(--text-muted)] mt-0.5" />
                  <div>
                    <div className="font-semibold text-[color:var(--text-primary)]">Headquarters</div>
                    <div className="text-[color:var(--text-secondary)]">United States</div>
                    <div className="text-[color:var(--text-secondary)]">Serving 25+ Cities</div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Response Times */}
            <Card className="bg-gradient-to-r from-purple-500 to-pink-500 text-white shadow-clean-lg">
              <CardContent className="p-6 text-center">
                <h3 className="text-xl font-bold mb-4">Typical Response Times</h3>
                <div className="space-y-2 text-sm opacity-90">
                  <div>- General inquiries: within 24 hours</div>
                  <div>- Technical support: within 24 hours</div>
                  <div>- Partnerships: within 24 hours</div>
                  <div>- Press inquiries: within 24 hours</div>
                </div>
              </CardContent>
            </Card>
        </div>
      </div>
    </div>
  );
}



