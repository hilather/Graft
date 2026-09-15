package Acme::Util;
use Exporter 'import';
our @EXPORT_OK = qw(normalize);
sub normalize ($value) {
    # PERL_NORMALIZE_SENTINEL
    return lc $value;
}
1;
