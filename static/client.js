$(function() {
  var fileName = window.location.hash.substring(1);
  if (fileName) {
    $("#download").removeClass("hidden").attr("href", downloadUrl(fileName));
    $("#reload").removeClass("hidden");
  }

  $('#upload').on('submit', function(event) {
    event.preventDefault();
    var form = $(this);
    var loader = $("#loading");

    loader.removeClass('hidden');

    var data = new FormData(form[0]);

    $.ajax({
      url: '/upload',
      type: 'POST',
      data: data,
      cache: false,
      processData: false,
      contentType: false
    }).done(function(res) {
      window.location.hash = res;
      pollResponse(res);
    });

    function pollResponse(res) {
      $.ajax("/status/" + res, {
        statusCode: {
          200: function() {
            loader.addClass("hidden");
            $("#download").attr("href", downloadUrl(res)).removeClass("hidden");
            $("#reload").removeClass("hidden");
          },
          202: function() {
            setTimeout(function() { pollResponse(res); }, 1000);
          },
          500: function() {
            loader.addClass("hidden");
            $("#error").removeClass("hidden");
          }
        }
      });
    }
  });
  function downloadUrl(fileName) {
    return "download/" + fileName;
  }
});
