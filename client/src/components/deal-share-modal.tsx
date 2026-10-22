import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Share2, Copy, Facebook, Twitter, MessageCircle, Mail, Check } from "lucide-react";
import { resolveCanonicalShareUrl } from "@/lib/share";

interface Deal {
  id: string;
  title: string;
  description: string;
  dealType?: string;
  discountValue: string;
  minOrderAmount?: string;
  restaurant?: {
    name: string;
    cuisineType?: string;
  };
}

interface DealShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  deal: Deal;
}

export default function DealShareModal({ isOpen, onClose, deal }: DealShareModalProps) {
  const [copied, setCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState(() => {
    if (typeof window === "undefined") return `/deal/${deal.id}`;
    return `${window.location.origin}/deal/${deal.id}`;
  });
  const { toast } = useToast();

  useEffect(() => {
    if (!isOpen) return;
    let isActive = true;

    const loadShareUrl = async () => {
      const url = await resolveCanonicalShareUrl(`/deal/${deal.id}`);
      if (isActive) {
        setShareUrl(url);
      }
    };

    loadShareUrl();
    return () => {
      isActive = false;
    };
  }, [deal.id, isOpen]);
  
  const discount = deal.dealType === "percentage" ? `${deal.discountValue}% OFF` : deal.dealType === "fixed" ? `$${deal.discountValue} OFF` : "View offer terms";
  const minimum = deal.minOrderAmount != null && deal.minOrderAmount !== "" ? `Minimum order: $${deal.minOrderAmount}` : "Minimum order not provided";
  const shareText = `Special at ${deal.restaurant?.name || 'this restaurant'}!\n\n${deal.title}\n${discount} (${minimum})\n\nCheck it out on MealScout:`;

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast({
        title: "Link Copied!",
        description: "Special link has been copied to your clipboard.",
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast({
        title: "Copy Failed",
        description: "Unable to copy link. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleFacebookShare = () => {
    const facebookUrl = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}&quote=${encodeURIComponent(shareText)}`;
    window.open(facebookUrl, '_blank', 'width=600,height=400');
  };

  const handleTwitterShare = () => {
    const twitterText = `${shareText} ${shareUrl}`;
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(twitterText)}`;
    window.open(twitterUrl, '_blank', 'width=600,height=400');
  };

  const handleWhatsAppShare = () => {
    const whatsappText = `${shareText} ${shareUrl}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(whatsappText)}`;
    window.open(whatsappUrl, '_blank');
  };

  const handleEmailShare = () => {
    const subject = `Great Special at ${deal.restaurant?.name || "a local restaurant"}!`;
    const body = `${shareText}\n\n${shareUrl}`;
    const emailUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.open(emailUrl);
  };

  const shareOptions = [
    {
      name: "Facebook",
      icon: Facebook,
      color: "bg-[color:var(--accent-text)] hover:bg-[color:var(--accent-text-hover)]",
      onClick: handleFacebookShare,
      testId: "button-share-facebook"
    },
    {
      name: "Twitter",
      icon: Twitter,
      color: "bg-[color:var(--accent-text)] hover:bg-[color:var(--accent-text-hover)]",
      onClick: handleTwitterShare,
      testId: "button-share-twitter"
    },
    {
      name: "WhatsApp",
      icon: MessageCircle,
      color: "bg-[color:var(--status-success)] hover:bg-[color:var(--status-success)]",
      onClick: handleWhatsAppShare,
      testId: "button-share-whatsapp"
    },
    {
      name: "Email",
      icon: Mail,
      color: "bg-[color:var(--text-secondary)] hover:bg-[color:var(--text-primary)]",
      onClick: handleEmailShare,
      testId: "button-share-email"
    },
  ];

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="w-full max-w-[95vw] sm:max-w-md mx-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <Share2 className="w-5 h-5" />
            <span>Share Special</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Deal Preview */}
          <div className="p-4 border rounded-lg bg-muted/30">
            <h3 className="font-semibold text-foreground text-sm mb-1">
              {deal.title}
            </h3>
            <p className="text-xs text-muted-foreground mb-2">
              {deal.restaurant?.name || 'Restaurant'} - {deal.restaurant?.cuisineType || 'Food'}
            </p>
            <div className="flex items-center space-x-2">
              <span className="bg-primary text-primary-foreground text-xs px-2 py-1 rounded-full font-semibold">
                {discount}
              </span>
              <span className="text-xs text-muted-foreground">
                {minimum}
              </span>
            </div>
          </div>

          {/* Share Link */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Share Link
            </label>
            <div className="flex space-x-2">
              <Input
                value={shareUrl}
                readOnly
                className="flex-1 text-sm"
                data-testid="input-share-url"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopyLink}
                className="px-3"
                data-testid="button-copy-link"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-[color:var(--status-success)]" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>

          {/* Social Share Options */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-3">
              Share On
            </label>
            <div className="grid grid-cols-2 gap-3">
              {shareOptions.map((option) => (
                <Button
                  key={option.name}
                  variant="outline"
                  className={`${option.color} text-white border-0 flex items-center justify-center space-x-2 py-3`}
                  onClick={option.onClick}
                  data-testid={option.testId}
                >
                  <option.icon className="w-4 h-4" />
                  <span className="text-sm">{option.name}</span>
                </Button>
              ))}
            </div>
          </div>

          {/* Share Stats (Future Enhancement) */}
          <div className="text-center">
            <p className="text-xs text-muted-foreground">
              Help others discover great deals in your area!
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}


